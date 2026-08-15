import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import type { Metadata } from "next";

import { DependencyCanvas } from "@/components/dependency-canvas";
import { DatabaseError } from "@/components/database-error";
import {
  ChokepointPanel,
  DuplicatePanel,
  LicensePanel,
  MaintainerPanel,
  VulnerabilityPanel,
} from "@/components/panels";
import { Badge, Panel, PanelSkeleton, QueryFootnote, Stat, cx } from "@/components/ui";
import { AppError, toAppError } from "@/lib/db/errors";
import { compactNumber, exactNumber, fileSize, monthYear, yearsAgo } from "@/lib/format";
import { versionKey } from "@/lib/graph/model";
import { getPackageVersions } from "@/lib/queries/discovery";
import { getUpgradeChokepoints, getVulnerabilityPaths, type ReachabilityScope } from "@/lib/queries/risk";
import {
  getBusFactor,
  getDuplicateVersions,
  getLicenseExposure,
  getMaintainerBlastRadius,
} from "@/lib/queries/supplychain";
import { getDependencyGraph, getPackageOverview, type GraphDepth } from "@/lib/queries/tree";

/**
 * The package dashboard.
 *
 * ## Why there is no API layer behind this page
 *
 * Every panel is a Server Component that calls the query layer directly. There
 * is no `/api/packages/...` route, no client-side fetch, and no loading
 * waterfall — the browser receives HTML with the answers already in it.
 *
 * The filters (production vs including-dev, and traversal depth) are plain links
 * that change the URL's search parameters, which re-runs the server render. That
 * means the state is shareable and bookmarkable, the back button works, and the
 * whole page needs almost no client-side JavaScript. The only client components
 * on this route are the graph canvas and the search box, because those genuinely
 * need to be interactive.
 *
 * Each panel sits in its own `Suspense` boundary so the seven queries stream in
 * independently rather than the slowest one holding up the page.
 */
export const dynamic = "force-dynamic";

interface PageProps {
  params: Promise<{ name: string }>;
  searchParams: Promise<{ version?: string; scope?: string; depth?: string }>;
}

/* -------------------------------------------------------------------------- */
/* Parameter handling                                                          */
/* -------------------------------------------------------------------------- */

function parseScope(raw: string | undefined): ReachabilityScope {
  return raw === "all" ? "all" : "production";
}

function parseDepth(raw: string | undefined): GraphDepth {
  const parsed = Number.parseInt(raw ?? "", 10);
  return parsed === 1 || parsed === 2 || parsed === 4 ? parsed : 3;
}

export async function generateMetadata({ params, searchParams }: PageProps): Promise<Metadata> {
  const { name } = await params;
  const { version } = await searchParams;
  const decoded = decodeURIComponent(name);
  return {
    title: version === undefined ? decoded : `${decoded}@${version}`,
    description: `Dependency graph, reachable advisories and maintainer exposure for ${decoded}.`,
  };
}

export default async function PackagePage({ params, searchParams }: PageProps) {
  const { name: rawName } = await params;
  const query = await searchParams;

  const name = decodeURIComponent(rawName);
  const scope = parseScope(query.scope);
  const depth = parseDepth(query.depth);

  // Resolve which stored version to show before anything else — the rest of the
  // page is keyed off it.
  //
  // `notFound()` is called *outside* the try/catch on purpose. It signals a 404
  // by throwing a sentinel that Next.js catches upstream, so wrapping it in a
  // catch swallows the signal and the route silently renders as a 200. Only the
  // database call belongs inside the guard; the routing decision belongs after
  // it.
  //
  // It also has to happen here, at the top of the page, rather than inside one
  // of the Suspense boundaries below: once streaming starts the response status
  // has already been sent, and a later `notFound()` can change what renders but
  // not the 404 the client receives.
  let record: Awaited<ReturnType<typeof getPackageVersions>>["rows"][number] | undefined;
  try {
    const { rows } = await getPackageVersions(name);
    record = rows[0];
  } catch (error) {
    return <DatabaseError error={toAppError(error)} />;
  }

  if (record === undefined || record.versions.length === 0) notFound();

  const requested = query.version;
  const version =
    requested !== undefined && record.versions.includes(requested)
      ? requested
      : (record.rootVersion ?? newestOf(record.versions));

  if (version === undefined) notFound();

  const resolved = { version, available: record.versions };

  const key = versionKey(name, resolved.version);
  const base = { name, version: resolved.version, scope, depth };

  return (
    <div className="mx-auto max-w-[1400px] px-6 py-8">
      <Suspense fallback={<HeaderSkeleton name={name} version={resolved.version} />}>
        <PackageHeader
          rootKey={key}
          name={name}
          availableVersions={resolved.available}
          current={base}
        />
      </Suspense>

      <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <div className="space-y-5">
          <Suspense fallback={<PanelSkeleton title="Dependency graph" rows={6} />}>
            <GraphPanel rootKey={key} depth={depth} current={base} />
          </Suspense>

          <Suspense fallback={<PanelSkeleton title="Reachable advisories" rows={5} />}>
            <VulnerabilitySection rootKey={key} scope={scope} />
          </Suspense>
        </div>

        <div className="space-y-5">
          <Suspense fallback={<PanelSkeleton title="Fix this first" rows={4} />}>
            <ChokepointSection rootKey={key} scope={scope} />
          </Suspense>

          <Suspense fallback={<PanelSkeleton title="Who can change what you install" rows={5} />}>
            <MaintainerSection rootKey={key} />
          </Suspense>

          <Suspense fallback={<PanelSkeleton title="Licence obligations" rows={4} />}>
            <LicenseSection rootKey={key} />
          </Suspense>

          <Suspense fallback={<PanelSkeleton title="Installed more than once" rows={4} />}>
            <DuplicateSection rootKey={key} />
          </Suspense>
        </div>
      </div>
    </div>
  );
}

/** Best-effort newest version, used when a package has no seeded root version. */
function newestOf(versions: string[]): string | undefined {
  return [...versions].sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }),
  )[versions.length - 1];
}

/* -------------------------------------------------------------------------- */
/* Header                                                                      */
/* -------------------------------------------------------------------------- */

interface CurrentView {
  name: string;
  version: string;
  scope: ReachabilityScope;
  depth: GraphDepth;
}

function hrefWith(current: CurrentView, patch: Partial<CurrentView>): string {
  const next = { ...current, ...patch };
  const search = new URLSearchParams({ version: next.version });
  if (next.scope !== "production") search.set("scope", next.scope);
  if (next.depth !== 3) search.set("depth", String(next.depth));
  return `/package/${encodeURIComponent(next.name)}?${search.toString()}`;
}

async function PackageHeader({
  rootKey,
  name,
  availableVersions,
  current,
}: {
  rootKey: string;
  name: string;
  availableVersions: string[];
  current: CurrentView;
}) {
  let overview;
  let meta;
  try {
    const result = await getPackageOverview(rootKey, current.scope);
    overview = result.rows[0];
    meta = result.meta;
  } catch (error) {
    return <DatabaseError error={toAppError(error)} />;
  }

  // The page component has already established that this version exists, so an
  // empty result here means the row vanished between two queries. Render an
  // error rather than calling notFound(): this component is inside a Suspense
  // boundary, so the 200 has already been streamed and a 404 would not reach
  // the client anyway.
  if (overview === undefined || meta === undefined) {
    return (
      <DatabaseError
        error={toAppError(
          new AppError("NOT_FOUND", `No stored version matching ${rootKey}.`, {
            hint: "The graph may have been re-seeded while this page was loading. Reload to try again.",
          }),
        )}
      />
    );
  }

  const age = yearsAgo(overview.publishedAt);
  const isOutdated =
    overview.latestVersion !== null && overview.latestVersion !== overview.version;

  return (
    <header>
      <nav className="mb-3 flex items-center gap-2 text-[12.5px] text-[var(--color-ink-faint)]">
        <Link href="/" className="transition-colors hover:text-[var(--color-ink-muted)]">
          Explore
        </Link>
        <span aria-hidden>/</span>
        <span className="font-mono text-[var(--color-ink-muted)]">{name}</span>
      </nav>

      <div className="flex flex-wrap items-start justify-between gap-5">
        <div className="min-w-0">
          <div className="flex flex-wrap items-baseline gap-3">
            <h1 className="font-mono text-2xl font-semibold tracking-tight">{name}</h1>
            <span className="font-mono text-lg text-[var(--color-ink-muted)]">
              {overview.version}
            </span>
            {overview.isRoot && (
              <Badge className="border-[color-mix(in_oklab,var(--color-accent)_30%,transparent)] bg-[var(--color-accent-ghost)] text-[var(--color-accent)]">
                seeded root
              </Badge>
            )}
          </div>

          {overview.description !== null && (
            <p className="mt-2 max-w-2xl text-[13.5px] leading-relaxed text-[var(--color-ink-muted)]">
              {overview.description}
            </p>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[12px] text-[var(--color-ink-faint)]">
            <span>published {monthYear(overview.publishedAt)}{age !== null && ` · ${age}`}</span>
            {overview.license !== null && <span>licence {overview.license}</span>}
            {overview.unpackedSize !== null && <span>{fileSize(overview.unpackedSize)} unpacked</span>}
            {overview.repository !== null && (
              <a
                href={overview.repository}
                target="_blank"
                rel="noreferrer"
                className="underline decoration-[var(--color-line-strong)] underline-offset-4 transition-colors hover:text-[var(--color-ink-muted)]"
              >
                repository
              </a>
            )}
          </div>

          {/* Honesty notices — the reader should never be misled about what
              version they are looking at or why. */}
          <div className="mt-3 flex flex-col gap-2">
            {overview.pinnedBecause !== null && (
              <Notice tone="info">
                This version was pinned deliberately when the graph was seeded.{" "}
                {overview.pinnedBecause}
              </Notice>
            )}
            {overview.deprecated !== null && (
              <Notice tone="warn">
                Deprecated by its maintainer: “{overview.deprecated}”
              </Notice>
            )}
            {isOutdated && overview.pinnedBecause === null && (
              <Notice tone="info">
                {overview.latestVersion} is the current release. You are looking at{" "}
                {overview.version}, which is what the crawl resolved.
              </Notice>
            )}
          </div>
        </div>

        <div className="flex shrink-0 flex-col items-end gap-3">
          <ScopeToggle current={current} />
          {availableVersions.length > 1 && (
            <VersionPicker
              current={current}
              versions={availableVersions}
              active={overview.version}
            />
          )}
        </div>
      </div>

      <div className="surface-card mt-5 grid grid-cols-2 divide-[var(--color-line)] sm:grid-cols-3 lg:grid-cols-6 lg:divide-x">
        <Stat
          label="direct deps"
          value={exactNumber(overview.directDependencies)}
          hint={
            current.scope === "production"
              ? "runtime and optional"
              : "including devDependencies"
          }
        />
        <Stat
          label="total tree"
          value={exactNumber(overview.totalDependencies)}
          hint={current.scope === "production" ? "reachable in production" : "everything reachable"}
        />
        <Stat label="deepest chain" value={`${overview.deepestChain} hops`} />
        <Stat
          label="advisories"
          value={exactNumber(overview.vulnerabilityCount)}
          tone={overview.criticalCount + overview.highCount > 0 ? "critical" : overview.vulnerabilityCount > 0 ? "high" : "good"}
          hint={
            overview.vulnerabilityCount === 0
              ? "none in the tree"
              : `${overview.criticalCount} critical · ${overview.highCount} high`
          }
        />
        <Stat
          label="deprecated"
          value={exactNumber(overview.deprecatedCount)}
          tone={overview.deprecatedCount > 0 ? "high" : "default"}
          hint="packages in the tree"
        />
        <Stat label="downloads" value={compactNumber(overview.weeklyDownloads)} hint="per week" />
      </div>

      <div className="mt-2">
        <QueryFootnote queryId="package-overview" serverMs={meta.consumedAfterMs} />
      </div>
    </header>
  );
}

function Notice({ tone, children }: { tone: "info" | "warn"; children: React.ReactNode }) {
  return (
    <p
      className={cx(
        "max-w-2xl rounded-lg border px-3 py-2 text-[12.5px] leading-relaxed",
        tone === "warn"
          ? "border-[color-mix(in_oklab,var(--color-high)_30%,transparent)] bg-[var(--color-high-ghost)] text-[var(--color-high)]"
          : "border-[var(--color-line-strong)] bg-[var(--color-surface-raised)] text-[var(--color-ink-muted)]",
      )}
    >
      {children}
    </p>
  );
}

/**
 * Production vs including-dev.
 *
 * Rendered as two links rather than a client-side toggle: the choice belongs in
 * the URL so it can be shared, and this way the control costs no JavaScript.
 */
function ScopeToggle({ current }: { current: CurrentView }) {
  const options: Array<{ value: ReachabilityScope; label: string; hint: string }> = [
    { value: "production", label: "Ships to production", hint: "runtime and optional dependencies only" },
    { value: "all", label: "Including dev", hint: "adds build and test tooling" },
  ];

  return (
    <div className="inline-flex rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-surface)] p-0.5">
      {options.map((option) => {
        const isActive = current.scope === option.value;
        return (
          <Link
            key={option.value}
            href={hrefWith(current, { scope: option.value })}
            title={option.hint}
            aria-current={isActive ? "true" : undefined}
            className={cx(
              "rounded-md px-3 py-1.5 text-[12.5px] font-medium transition-colors",
              isActive
                ? "bg-[var(--color-surface-hover)] text-[var(--color-ink)]"
                : "text-[var(--color-ink-faint)] hover:text-[var(--color-ink-muted)]",
            )}
          >
            {option.label}
          </Link>
        );
      })}
    </div>
  );
}

function VersionPicker({
  current,
  versions,
  active,
}: {
  current: CurrentView;
  versions: string[];
  active: string;
}) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-1.5">
      <span className="text-[11.5px] text-[var(--color-ink-faint)]">
        also in this graph:
      </span>
      {versions
        .filter((version) => version !== active)
        .slice(0, 5)
        .map((version) => (
          <Link key={version} href={hrefWith(current, { version })}>
            <Badge>{version}</Badge>
          </Link>
        ))}
    </div>
  );
}

function HeaderSkeleton({ name, version }: { name: string; version: string }) {
  return (
    <div aria-busy="true">
      <div className="flex items-baseline gap-3">
        <h1 className="font-mono text-2xl font-semibold tracking-tight">{name}</h1>
        <span className="font-mono text-lg text-[var(--color-ink-muted)]">{version}</span>
      </div>
      <div className="shimmer mt-3 h-4 w-96 rounded" />
      <div className="surface-card mt-5 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
        {Array.from({ length: 6 }, (_, index) => (
          <div key={index} className="px-5 py-4">
            <div className="shimmer h-3 w-16 rounded" />
            <div className="shimmer mt-2 h-6 w-12 rounded" />
          </div>
        ))}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Sections                                                                    */
/* -------------------------------------------------------------------------- */

async function GraphPanel({
  rootKey,
  depth,
  current,
}: {
  rootKey: string;
  depth: GraphDepth;
  current: CurrentView;
}) {
  try {
    const { nodes, edges, meta } = await getDependencyGraph(rootKey, depth, 400);

    return (
      <Panel
        title="The tree itself"
        description="Every resolved version reachable from this package, laid out left to right by distance from it. Vulnerable packages are coloured by severity. This view always shows the whole tree — dev-only dependencies appear on dashed edges rather than being hidden."
        aside={<DepthToggle current={current} />}
      >
        <div className="p-4">
          {nodes.length === 0 ? (
            <p className="py-10 text-center text-[13px] text-[var(--color-ink-muted)]">
              This package has no dependencies at all.
            </p>
          ) : (
            <DependencyCanvas nodes={nodes} edges={edges} rootKey={rootKey} />
          )}
        </div>
        <QueryFootnote
          queryId="dependency-graph-nodes"
          serverMs={meta.consumedAfterMs}
          rowCount={nodes.length}
        />
      </Panel>
    );
  } catch (error) {
    return <DatabaseError error={toAppError(error)} />;
  }
}

function DepthToggle({ current }: { current: CurrentView }) {
  return (
    <div className="inline-flex items-center gap-2">
      <span className="text-[11.5px] text-[var(--color-ink-faint)]">depth</span>
      <div className="inline-flex rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-surface)] p-0.5">
        {([1, 2, 3, 4] as const).map((value) => (
          <Link
            key={value}
            href={hrefWith(current, { depth: value })}
            aria-current={current.depth === value ? "true" : undefined}
            className={cx(
              "tabular rounded-md px-2.5 py-1 font-mono text-[12px] transition-colors",
              current.depth === value
                ? "bg-[var(--color-surface-hover)] text-[var(--color-ink)]"
                : "text-[var(--color-ink-faint)] hover:text-[var(--color-ink-muted)]",
            )}
          >
            {value}
          </Link>
        ))}
      </div>
    </div>
  );
}

async function VulnerabilitySection({
  rootKey,
  scope,
}: {
  rootKey: string;
  scope: ReachabilityScope;
}) {
  try {
    const { rows, meta } = await getVulnerabilityPaths(rootKey, undefined, scope);
    return <VulnerabilityPanel rows={rows} meta={meta} scope={scope} rootKey={rootKey} />;
  } catch (error) {
    return <DatabaseError error={toAppError(error)} />;
  }
}

async function ChokepointSection({
  rootKey,
  scope,
}: {
  rootKey: string;
  scope: ReachabilityScope;
}) {
  try {
    const { rows, meta } = await getUpgradeChokepoints(rootKey, 8, scope);
    return <ChokepointPanel rows={rows} meta={meta} scope={scope} />;
  } catch (error) {
    return <DatabaseError error={toAppError(error)} />;
  }
}

async function MaintainerSection({ rootKey }: { rootKey: string }) {
  try {
    const [reach, busFactor] = await Promise.all([
      getMaintainerBlastRadius(rootKey, 8),
      getBusFactor(rootKey, 24),
    ]);
    return (
      <MaintainerPanel reach={reach.rows} busFactor={busFactor.rows} meta={reach.meta} />
    );
  } catch (error) {
    return <DatabaseError error={toAppError(error)} />;
  }
}

async function LicenseSection({ rootKey }: { rootKey: string }) {
  try {
    const { rows, meta } = await getLicenseExposure(rootKey);
    return <LicensePanel rows={rows} meta={meta} />;
  } catch (error) {
    return <DatabaseError error={toAppError(error)} />;
  }
}

async function DuplicateSection({ rootKey }: { rootKey: string }) {
  try {
    const { rows, meta } = await getDuplicateVersions(rootKey);
    return <DuplicatePanel rows={rows} meta={meta} />;
  } catch (error) {
    return <DatabaseError error={toAppError(error)} />;
  }
}
