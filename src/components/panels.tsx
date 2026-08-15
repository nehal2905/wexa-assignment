import Link from "next/link";

import {
  Badge,
  Code,
  EmptyState,
  Panel,
  QueryFootnote,
  cx,
} from "@/components/ui";
import {
  LICENSE_CLASSES,
  LICENSE_LABEL,
  LICENSE_NOTE,
  SCOPE_LABEL,
  SEVERITY_CLASSES,
  SEVERITY_LABEL,
  compactNumber,
  isDevOnlyPath,
  packageHref,
} from "@/lib/format";
import { parseVersionKey } from "@/lib/graph/model";
import type { QueryMeta } from "@/lib/db/driver";
import type { Chokepoint, VulnerabilityPath } from "@/lib/queries/risk";
import type {
  BusFactorRow,
  DuplicateVersion,
  LicenseExposure,
  MaintainerReach,
} from "@/lib/queries/supplychain";

/**
 * The individual analysis panels on the package page.
 *
 * All server components. Each one owns its own empty state, because "no results"
 * means something different in every panel and a shared generic message would
 * lose that: no advisories is good news, no maintainers listed is a data gap,
 * no duplicate versions is a tidy tree.
 */

/* -------------------------------------------------------------------------- */
/* Fix this first                                                              */
/* -------------------------------------------------------------------------- */

export function ChokepointPanel({
  rows,
  meta,
  scope,
}: {
  rows: Chokepoint[];
  meta: QueryMeta;
  scope: "production" | "all";
}) {
  const top = rows[0];

  return (
    <Panel
      title="Fix this first"
      description="Every route to a vulnerability, grouped by the direct dependency it passes through. The package at the top is the single upgrade that clears the most risk."
    >
      {rows.length === 0 ? (
        <EmptyState
          icon="+"
          title="Nothing to fix here"
          description={
            scope === "production"
              ? "No advisory in this graph is reachable through a dependency that ships to production."
              : "No advisory in this graph is reachable from this package at all."
          }
        />
      ) : (
        <>
          {top !== undefined && (
            <div className="border-b border-[var(--color-line)] bg-[var(--color-accent-ghost)]/40 px-5 py-4">
              {/* Deliberately not "N of M". Summing the per-chokepoint counts
                  does not give a meaningful total: one advisory reachable
                  through two different direct dependencies is counted under
                  both, and advisories on the audited package itself have no
                  chokepoint at all. Quoting that sum as a denominator would
                  contradict the header, which counts distinct advisories. */}
              <p className="text-[13px] leading-relaxed text-[var(--color-ink-muted)]">
                Upgrading <Code className="text-[var(--color-accent)]">{top.packageName}</Code> alone
                would clear{" "}
                <strong className="font-semibold text-[var(--color-ink)]">
                  {top.vulnerabilityCount} advisor{top.vulnerabilityCount === 1 ? "y" : "ies"}
                </strong>
                {rows.length > 1 ? " - more than any other single change." : "."}
              </p>
            </div>
          )}

          <ul className="divide-y divide-[var(--color-line)]">
            {rows.map((row, index) => (
              <li key={`${row.packageName}@${row.version}`} className="flex items-start gap-4 px-5 py-3.5">
                <span className="tabular mt-0.5 w-5 shrink-0 font-mono text-[11px] text-[var(--color-ink-faint)]">
                  {String(index + 1).padStart(2, "0")}
                </span>

                <div className="min-w-0 flex-1">
                  <Link
                    href={packageHref(row.packageName, row.version)}
                    className="font-mono text-[13px] text-[var(--color-ink)] transition-colors hover:text-[var(--color-accent)]"
                  >
                    {row.packageName}
                    <span className="text-[var(--color-ink-faint)]">@{row.version}</span>
                  </Link>
                  <p className="mt-1 text-[12px] leading-relaxed text-[var(--color-ink-faint)]">
                    reaches {row.examples.slice(0, 4).join(", ")}
                    {row.examples.length > 4 && ` and ${row.examples.length - 4} more`}
                  </p>
                </div>

                <div className="flex shrink-0 items-center gap-2">
                  {row.worstScore !== null && (
                    <Badge
                      className={cx(
                        row.hasSevere
                          ? "border-[color-mix(in_oklab,var(--color-critical)_32%,transparent)] bg-[var(--color-critical-ghost)] text-[var(--color-critical)]"
                          : undefined,
                      )}
                      title="Highest CVSS base score reachable through this dependency"
                    >
                      {row.worstScore.toFixed(1)}
                    </Badge>
                  )}
                  <Badge>
                    {row.vulnerabilityCount} advisor{row.vulnerabilityCount === 1 ? "y" : "ies"}
                  </Badge>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      <QueryFootnote
        queryId="upgrade-chokepoints"
        serverMs={meta.consumedAfterMs}
        rowCount={meta.rowCount}
      />
    </Panel>
  );
}


/* -------------------------------------------------------------------------- */
/* Vulnerability paths                                                         */
/* -------------------------------------------------------------------------- */

export function VulnerabilityPanel({
  rows,
  meta,
  scope,
  rootKey,
}: {
  rows: VulnerabilityPath[];
  meta: QueryMeta;
  scope: "production" | "all";
  rootKey: string;
}) {
  return (
    <Panel
      title="Reachable advisories"
      description="Not a list of packages with CVEs - a list of routes. Each row is the actual chain of dependencies connecting this package to something with a published advisory."
    >
      {rows.length === 0 ? (
        <EmptyState
          icon="+"
          title={scope === "production" ? "Nothing reachable in production" : "Nothing reachable"}
          description={
            scope === "production"
              ? "No path exists from this package to a known advisory through dependencies that ship. Switching to 'including dev' may still surface routes through build and test tooling."
              : "No path of eight hops or fewer connects this package to any advisory in the dataset."
          }
        />
      ) : (
        <ul className="divide-y divide-[var(--color-line)]">
          {rows.map((row) => (
            <li key={`${row.id}-${row.targetKey}`} className="px-5 py-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge className={SEVERITY_CLASSES[row.severity]}>
                      {SEVERITY_LABEL[row.severity]}
                      {row.cvssScore !== null && ` ${row.cvssScore.toFixed(1)}`}
                    </Badge>

                    {row.url !== null ? (
                      <a
                        href={row.url}
                        target="_blank"
                        rel="noreferrer"
                        className="font-mono text-[11.5px] text-[var(--color-ink-muted)] underline decoration-[var(--color-line-strong)] underline-offset-4 transition-colors hover:text-[var(--color-accent)]"
                      >
                        {row.id}
                      </a>
                    ) : (
                      <span className="font-mono text-[11.5px] text-[var(--color-ink-muted)]">
                        {row.id}
                      </span>
                    )}

                    {isDevOnlyPath(row.pathScopes) && (
                      <Badge
                        className="border-[var(--color-line-strong)] bg-[var(--color-surface-raised)] text-[var(--color-ink-faint)]"
                        title="This route runs through a devDependency, so it does not reach production"
                      >
                        dev only
                      </Badge>
                    )}
                  </div>

                  <p className="mt-2 text-[13px] leading-relaxed text-[var(--color-ink)]">
                    {row.summary}
                  </p>
                </div>

                <div className="shrink-0 text-right">
                  <p className="font-mono text-[11px] text-[var(--color-ink-faint)]">
                    {row.depth === 0 ? "this package" : `${row.depth} hop${row.depth === 1 ? "" : "s"}`}
                  </p>
                  {row.fixedIn !== null ? (
                    <p className="mt-1 font-mono text-[11px] text-[var(--color-accent)]">
                      fixed in {row.fixedIn}
                    </p>
                  ) : (
                    <p className="mt-1 font-mono text-[11px] text-[var(--color-high)]">unpatched</p>
                  )}
                </div>
              </div>

              <PathTrail keys={row.pathKeys} scopes={row.pathScopes} rootKey={rootKey} />
            </li>
          ))}
        </ul>
      )}
      <QueryFootnote
        queryId="vulnerability-paths"
        serverMs={meta.consumedAfterMs}
        rowCount={meta.rowCount}
      />
    </Panel>
  );
}

/**
 * The path itself, rendered as a chain.
 *
 * This is the single most important thing on the page: it is the difference
 * between "handlebars has an RCE" (true but useless - you never installed
 * handlebars) and "your app -> hbs -> handlebars" (actionable, and it tells you
 * which package to actually go and change).
 */
function PathTrail({
  keys,
  scopes,
  rootKey,
}: {
  keys: string[];
  scopes: string[];
  rootKey: string;
}) {
  if (keys.length <= 1) {
    return (
      <p className="mt-3 text-[12px] text-[var(--color-ink-faint)]">
        The advisory applies to this package directly.
      </p>
    );
  }

  return (
    <ol className="mt-3 flex flex-wrap items-center gap-x-1.5 gap-y-2">
      {keys.map((key, index) => {
        const parsed = parseVersionKey(key);
        const isRoot = key === rootKey;
        const isLast = index === keys.length - 1;
        const incomingScope = index > 0 ? scopes[index - 1] : undefined;

        return (
          <li key={key} className="flex items-center gap-1.5">
            {index > 0 && (
              <span
                className="font-mono text-[11px] text-[var(--color-ink-faint)]"
                title={
                  incomingScope !== undefined
                    ? `declared as a ${SCOPE_LABEL[incomingScope] ?? incomingScope} dependency`
                    : undefined
                }
              >
                {incomingScope === "dev" ? "-->" : "->"}
              </span>
            )}

            {isRoot ? (
              <span className="rounded border border-[color-mix(in_oklab,var(--color-accent)_30%,transparent)] bg-[var(--color-accent-ghost)] px-1.5 py-0.5 font-mono text-[11.5px] text-[var(--color-accent)]">
                {parsed?.packageName ?? key}
              </span>
            ) : (
              <Link
                href={packageHref(parsed?.packageName ?? key, parsed?.version)}
                className={cx(
                  "rounded border px-1.5 py-0.5 font-mono text-[11.5px] transition-colors",
                  isLast
                    ? "border-[color-mix(in_oklab,var(--color-critical)_30%,transparent)] bg-[var(--color-critical-ghost)] text-[var(--color-critical)] hover:bg-[var(--color-critical-ghost)]/70"
                    : "border-[var(--color-line-strong)] bg-[var(--color-surface-raised)] text-[var(--color-ink-muted)] hover:text-[var(--color-ink)]",
                )}
              >
                {parsed?.packageName ?? key}
                <span className="opacity-55">@{parsed?.version}</span>
              </Link>
            )}
          </li>
        );
      })}
    </ol>
  );
}

/* -------------------------------------------------------------------------- */
/* Maintainers                                                                 */
/* -------------------------------------------------------------------------- */

export function MaintainerPanel({
  reach,
  busFactor,
  meta,
}: {
  reach: MaintainerReach[];
  busFactor: BusFactorRow[];
  meta: QueryMeta;
}) {
  const topReach = reach[0];

  return (
    <Panel
      title="Who can change what you install"
      description="Publishing rights, not code quality. If one of these accounts were compromised, this is how much of your dependency tree the attacker could publish to."
    >
      {reach.length === 0 ? (
        <EmptyState
          icon="o"
          title="No maintainer data"
          description="The registry did not list maintainers for the packages in this tree."
        />
      ) : (
        <>
          {topReach !== undefined && (
            <div className="border-b border-[var(--color-line)] px-5 py-3.5">
              <p className="text-[13px] leading-relaxed text-[var(--color-ink-muted)]">
                <Code>{topReach.username}</Code> can publish to{" "}
                <strong className="font-semibold text-[var(--color-ink)]">
                  {topReach.packageCount} packages
                </strong>{" "}
                in this tree.
              </p>
            </div>
          )}

          <ul className="divide-y divide-[var(--color-line)]">
            {reach.map((person) => (
              <li key={person.username} className="flex items-center gap-4 px-5 py-3">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[var(--color-line-strong)] bg-[var(--color-surface-raised)] font-mono text-[11px] uppercase text-[var(--color-ink-muted)]">
                  {person.username.slice(0, 2)}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-mono text-[12.5px] text-[var(--color-ink)]">
                    {person.username}
                  </p>
                  <p className="mt-0.5 truncate text-[11.5px] text-[var(--color-ink-faint)]">
                    {person.examples.slice(0, 5).join(", ")}
                  </p>
                </div>
                {/* A proportional bar reads faster than a number when the point
                    is "this one is far larger than the others". */}
                <div className="flex shrink-0 items-center gap-2">
                  <span
                    aria-hidden
                    className="h-1.5 rounded-full bg-[var(--color-accent-dim)]"
                    style={{
                      width: `${Math.max(6, (person.packageCount / (topReach?.packageCount ?? 1)) * 56)}px`,
                    }}
                  />
                  <span className="tabular w-7 text-right font-mono text-[11.5px] text-[var(--color-ink-muted)]">
                    {person.packageCount}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}

      {busFactor.length > 0 && (
        <div className="border-t border-[var(--color-line)] px-5 py-4">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--color-ink-faint)]">
            Single-maintainer packages
          </h3>
          <p className="mt-1.5 text-[12.5px] leading-relaxed text-[var(--color-ink-muted)]">
            {busFactor.length} package{busFactor.length === 1 ? " has" : "s have"} exactly one
            person who can publish{busFactor.length === 1 ? "" : " to them"}.
          </p>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {busFactor.slice(0, 12).map((row) => (
              <Link key={row.packageName} href={packageHref(row.packageName)}>
                <Badge title={`maintained solely by ${row.maintainer} | ${compactNumber(row.weeklyDownloads)} downloads/week`}>
                  {row.packageName}
                </Badge>
              </Link>
            ))}
          </div>
        </div>
      )}

      <QueryFootnote
        queryId="maintainer-blast-radius"
        serverMs={meta.consumedAfterMs}
        rowCount={meta.rowCount}
      />
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */
/* Licences                                                                    */
/* -------------------------------------------------------------------------- */

export function LicensePanel({ rows, meta }: { rows: LicenseExposure[]; meta: QueryMeta }) {
  const notable = rows.filter(
    (row) => row.category !== "permissive" && row.category !== "unknown",
  );

  return (
    <Panel
      title="Licence obligations"
      description="What you are agreeing to by installing this, and how far down each obligation is buried. A copyleft licence you chose is a decision; one arriving at depth five is a discovery."
    >
      {rows.length === 0 ? (
        <EmptyState
          icon="o"
          title="No licence data"
          description="None of the packages in this tree declared a licence the crawler could read."
        />
      ) : (
        <>
          {notable.length > 0 && (
            <div className="border-b border-[var(--color-line)] bg-[var(--color-high-ghost)]/30 px-5 py-3.5">
              <p className="text-[13px] leading-relaxed text-[var(--color-ink-muted)]">
                {notable.length} licence{notable.length === 1 ? "" : "s"} in this tree carry
                obligations beyond attribution - the shallowest sits{" "}
                <strong className="font-semibold text-[var(--color-ink)]">
                  {notable[0]?.shallowestDepth === 0
                    ? "on this package itself"
                    : `${notable[0]?.shallowestDepth} hop${notable[0]?.shallowestDepth === 1 ? "" : "s"} down`}
                </strong>
                .
              </p>
            </div>
          )}

          <ul className="divide-y divide-[var(--color-line)]">
            {rows.map((row) => (
              <li key={row.spdxId} className="flex items-start gap-4 px-5 py-3">
                <Badge className={cx("shrink-0", LICENSE_CLASSES[row.category])}>
                  {row.spdxId}
                </Badge>
                <div className="min-w-0 flex-1">
                  <p className="text-[12.5px] text-[var(--color-ink)]">
                    {LICENSE_LABEL[row.category]}
                  </p>
                  <p className="mt-0.5 text-[11.5px] leading-relaxed text-[var(--color-ink-faint)]">
                    {LICENSE_NOTE[row.category]}
                  </p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="tabular font-mono text-[12px] text-[var(--color-ink-muted)]">
                    {row.packageCount}
                  </p>
                  <p className="font-mono text-[10.5px] text-[var(--color-ink-faint)]">
                    depth {row.shallowestDepth}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      <QueryFootnote
        queryId="license-exposure"
        serverMs={meta.consumedAfterMs}
        rowCount={meta.rowCount}
      />
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */
/* Duplicates                                                                  */
/* -------------------------------------------------------------------------- */

export function DuplicatePanel({
  rows,
  meta,
}: {
  rows: DuplicateVersion[];
  meta: QueryMeta;
}) {
  return (
    <Panel
      title="Installed more than once"
      description="Packages that appear at several versions in the same tree, because different dependencies asked for incompatible ranges. Each copy is real bytes on disk."
    >
      {rows.length === 0 ? (
        <EmptyState
          icon="+"
          title="No duplicates"
          description="Every package in this tree resolved to exactly one version - unusually tidy."
        />
      ) : (
        <ul className="divide-y divide-[var(--color-line)]">
          {rows.slice(0, 14).map((row) => (
            <li key={row.packageName} className="flex items-center gap-4 px-5 py-2.5">
              <Link
                href={packageHref(row.packageName)}
                className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-[var(--color-ink-muted)] transition-colors hover:text-[var(--color-ink)]"
              >
                {row.packageName}
              </Link>
              <div className="flex shrink-0 flex-wrap justify-end gap-1">
                {row.versions.slice(0, 4).map((version) => (
                  <Badge key={version}>{version}</Badge>
                ))}
                {row.versions.length > 4 && (
                  <Badge>+{row.versions.length - 4}</Badge>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <QueryFootnote
        queryId="duplicate-versions"
        serverMs={meta.consumedAfterMs}
        rowCount={meta.rowCount}
      />
    </Panel>
  );
}
