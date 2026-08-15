import Link from "next/link";
import { Suspense } from "react";

import { PackageSearch } from "@/components/package-search";
import { Badge, EmptyState, PanelSkeleton, cx } from "@/components/ui";
import { DatabaseError } from "@/components/database-error";
import { toAppError } from "@/lib/db/errors";
import { compactNumber, packageHref } from "@/lib/format";
import { getGraphStatistics, listRootPackages, type RootPackageSummary } from "@/lib/queries/discovery";

/**
 * Landing page.
 *
 * Rendered on the server, so the package grid arrives as HTML with no client
 * fetch and no loading flash. The two data panels are wrapped in separate
 * `Suspense` boundaries: the statistics bar and the package grid are independent
 * queries, and streaming them separately means a slow one never holds up the
 * other.
 */
export const dynamic = "force-dynamic";

export default function HomePage() {
  return (
    <div className="mx-auto max-w-[1400px] px-6">
      <Hero />

      <Suspense fallback={<StatsBarSkeleton />}>
        <StatsBar />
      </Suspense>

      <section className="mt-14 pb-4">
        <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">Start from a real project</h2>
            <p className="mt-1.5 max-w-2xl text-[13.5px] leading-relaxed text-[var(--color-ink-muted)]">
              Each of these was crawled from the npm registry and matched against live OSV
              advisories. Several are deliberately pinned to older releases — the versions
              people are still actually running. Counts below are{" "}
              <strong className="font-medium text-[var(--color-ink)]">
                advisories reachable through dependencies that ship
              </strong>
              ; build and test tooling is excluded until you ask for it.
            </p>
          </div>
        </div>

        <Suspense fallback={<RootGridSkeleton />}>
          <RootGrid />
        </Suspense>
      </section>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Hero                                                                        */
/* -------------------------------------------------------------------------- */

function Hero() {
  return (
    <section className="relative overflow-hidden pt-16 pb-12">
      <div
        aria-hidden
        className="grid-backdrop pointer-events-none absolute inset-x-0 top-0 h-64 opacity-40 [mask-image:linear-gradient(to_bottom,black,transparent)]"
      />

      <div className="relative">
        <p className="mb-4 font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--color-accent)]">
          Dependency reachability, as a graph
        </p>

        <h1 className="max-w-3xl text-[clamp(2rem,5vw,3.25rem)] font-semibold leading-[1.08] tracking-[-0.02em]">
          The dependency graph beneath your{" "}
          <span className="font-mono text-[0.82em] text-[var(--color-accent)]">package.json</span>
        </h1>

        <p className="mt-5 max-w-2xl text-[15px] leading-relaxed text-[var(--color-ink-muted)]">
          You install one package. You get four hundred. Understory walks every
          resolved version underneath it to answer the question that actually matters:
          not <em className="text-[var(--color-ink)] not-italic">does something have a CVE</em>, but{" "}
          <em className="text-[var(--color-ink)] not-italic">
            can my code reach it, and through exactly which chain
          </em>
          .
        </p>

        <div className="mt-8 max-w-xl">
          <PackageSearch autoFocus />
        </div>

        <div className="mt-5 flex flex-wrap items-center gap-2 text-[12.5px] text-[var(--color-ink-faint)]">
          <span>Or jump straight to</span>
          {[
            { name: "express", version: "4.17.1" },
            { name: "axios", version: "0.21.0" },
            { name: "gulp", version: "3.9.1" },
          ].map((example) => (
            <Link
              key={example.name}
              href={packageHref(example.name, example.version)}
              className="rounded-md border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-2 py-1 font-mono text-[11.5px] text-[var(--color-ink-muted)] transition-colors hover:border-[var(--color-accent-dim)] hover:text-[var(--color-accent)]"
            >
              {example.name}@{example.version}
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Statistics                                                                  */
/* -------------------------------------------------------------------------- */

async function StatsBar() {
  try {
    const { rows } = await getGraphStatistics();
    const stats = rows[0];
    if (stats === undefined) return null;

    const items = [
      { label: "packages", value: stats.packages },
      { label: "resolved versions", value: stats.versions },
      { label: "dependency edges", value: stats.dependencyEdges },
      { label: "advisories", value: stats.vulnerabilities },
      { label: "maintainers", value: stats.maintainers },
    ];

    return (
      <div className="surface-card grid grid-cols-2 divide-[var(--color-line)] sm:grid-cols-3 lg:grid-cols-5 lg:divide-x">
        {items.map((item) => (
          <div key={item.label} className="border-b border-[var(--color-line)] px-5 py-4 lg:border-b-0">
            <p className="tabular text-xl font-semibold tracking-tight">
              {item.value.toLocaleString("en-US")}
            </p>
            <p className="mt-0.5 text-[11.5px] uppercase tracking-[0.08em] text-[var(--color-ink-faint)]">
              {item.label}
            </p>
          </div>
        ))}
      </div>
    );
  } catch (error) {
    // The landing page is the first thing anyone sees, including someone who has
    // just cloned the repo. A misconfigured or unreachable database gets the full
    // diagnostic screen here rather than a blank page.
    return <DatabaseError error={toAppError(error)} />;
  }
}

function StatsBarSkeleton() {
  return (
    <div className="surface-card grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5" aria-busy="true">
      {Array.from({ length: 5 }, (_, index) => (
        <div key={index} className="border-b border-[var(--color-line)] px-5 py-4 lg:border-b-0">
          <div className="shimmer h-6 w-20 rounded" />
          <div className="shimmer mt-2 h-3 w-24 rounded" />
        </div>
      ))}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Root package grid                                                           */
/* -------------------------------------------------------------------------- */

async function RootGrid() {
  let roots: RootPackageSummary[];
  try {
    const result = await listRootPackages();
    roots = result.rows;
  } catch (error) {
    return <DatabaseError error={toAppError(error)} />;
  }

  if (roots.length === 0) {
    return (
      <div className="surface-card">
        <EmptyState
          icon="◇"
          title="The graph is empty"
          description="The schema exists but no data has been loaded yet. Run `npm run db:seed` to crawl the registry and populate it."
        />
      </div>
    );
  }

  return (
    <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {roots.map((root, index) => (
        <li
          key={root.name}
          className="animate-fade-up"
          // A short stagger makes the grid resolve as a wave rather than a flash.
          // Capped so the last card is never noticeably late.
          style={{ animationDelay: `${Math.min(index * 22, 320)}ms` }}
        >
          <RootCard root={root} />
        </li>
      ))}
    </ul>
  );
}

function RootCard({ root }: { root: RootPackageSummary }) {
  const hasSevere = root.severeCount > 0;
  const isClean = root.vulnerabilityCount === 0;

  return (
    <Link
      href={packageHref(root.name, root.version)}
      className="group surface-card flex h-full flex-col p-4 transition-colors hover:border-[var(--color-line-strong)] hover:bg-[var(--color-surface-raised)]"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-mono text-[13.5px] font-medium text-[var(--color-ink)]">
            {root.name}
          </p>
          <p className="mt-0.5 font-mono text-[11.5px] text-[var(--color-ink-faint)]">
            {root.version}
            {root.pinnedBecause !== null && (
              <span className="ml-1.5 text-[var(--color-high)]" title={root.pinnedBecause}>
                pinned
              </span>
            )}
          </p>
        </div>

        <span
          className={cx(
            "tabular shrink-0 rounded-lg border px-2 py-1 text-center font-mono text-[11px] leading-tight",
            isClean
              ? "border-[color-mix(in_oklab,var(--color-accent)_28%,transparent)] bg-[var(--color-accent-ghost)] text-[var(--color-accent)]"
              : hasSevere
                ? "border-[color-mix(in_oklab,var(--color-critical)_32%,transparent)] bg-[var(--color-critical-ghost)] text-[var(--color-critical)]"
                : "border-[color-mix(in_oklab,var(--color-moderate)_30%,transparent)] bg-[var(--color-moderate-ghost)] text-[var(--color-moderate)]",
          )}
        >
          <span className="block text-[15px] font-semibold">{root.vulnerabilityCount}</span>
          <span className="block opacity-70">{isClean ? "clean" : "advisories"}</span>
        </span>
      </div>

      <p className="mt-3 line-clamp-2 min-h-[2.5rem] text-[12.5px] leading-relaxed text-[var(--color-ink-muted)]">
        {root.blurb ?? root.description ?? "No description published."}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-[var(--color-line)] pt-3">
        <Badge>{root.dependencyCount} deps</Badge>
        <Badge>{compactNumber(root.weeklyDownloads)}/wk</Badge>
        {hasSevere && (
          <Badge className="border-[color-mix(in_oklab,var(--color-critical)_32%,transparent)] bg-[var(--color-critical-ghost)] text-[var(--color-critical)]">
            {root.severeCount} severe
          </Badge>
        )}
        {root.category !== null && (
          <span className="ml-auto text-[11px] text-[var(--color-ink-faint)]">{root.category}</span>
        )}
      </div>
    </Link>
  );
}

function RootGridSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true">
      {Array.from({ length: 9 }, (_, index) => (
        <PanelSkeleton key={index} rows={2} />
      ))}
    </div>
  );
}
