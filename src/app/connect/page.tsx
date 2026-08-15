import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { DatabaseError } from "@/components/database-error";
import { PackagePicker } from "@/components/package-picker";
import {
  Badge,
  Code,
  EmptyState,
  Panel,
  PanelSkeleton,
  QueryFootnote,
  SectionHeading,
} from "@/components/ui";
import { toAppError } from "@/lib/db/errors";
import { SCOPE_LABEL, packageHref } from "@/lib/format";
import { parseVersionKey } from "@/lib/graph/model";
import { findConnectionPath, getDependents } from "@/lib/queries/compare";

/**
 * "Why is this in my node_modules?"
 *
 * Everyone who has opened a lockfile has asked this. Nothing in your
 * package.json mentions `ms`, and yet there it is. The answer is a shortest path
 * - one Cypher function against a graph, versus a hand-written breadth-first
 * search in a recursive CTE against a relational one.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Trace a path",
  description:
    "Find the shortest chain of dependencies connecting one npm package to another, and see which packages pull a given library in.",
};

interface PageProps {
  searchParams: Promise<{ from?: string; to?: string }>;
}

export default async function ConnectPage({ searchParams }: PageProps) {
  const { from = null, to = null } = await searchParams;

  return (
    <div className="mx-auto max-w-[1000px] px-6 py-10">
      <SectionHeading
        eyebrow="Path finding"
        title="Why is this in my node_modules?"
        description="Nothing in your package.json mentions it, yet there it is on disk. Pick where you start and what you are trying to explain, and Understory returns the shortest chain of dependencies connecting them."
      />

      <div className="surface-card grid gap-4 p-5 sm:grid-cols-2">
        <PackagePicker param="from" label="Starting from" placeholder="e.g. express" selected={from} />
        <PackagePicker param="to" label="Trying to explain" placeholder="e.g. ms" selected={to} />
      </div>

      <div className="mt-5">
        {from === null || to === null ? (
          <div className="surface-card">
            <EmptyState
              icon=">"
              title="Pick both ends"
              description="Choose a package you know you installed, and one you did not expect to find."
              action={
                <div className="flex flex-wrap justify-center gap-2">
                  {[
                    ["express", "ms"],
                    ["webpack", "minimist"],
                    ["jest", "chalk"],
                  ].map(([a, b]) => (
                    <Link
                      key={`${a}-${b}`}
                      href={`/connect?from=${a}&to=${b}`}
                      className="rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-1.5 font-mono text-[12px] text-[var(--color-ink-muted)] transition-colors hover:border-[var(--color-accent-dim)] hover:text-[var(--color-accent)]"
                    >
                      {a} {'->'} {b}
                    </Link>
                  ))}
                </div>
              }
            />
          </div>
        ) : (
          <Suspense key={`${from}-${to}`} fallback={<PanelSkeleton title="Searching..." rows={3} />}>
            <PathResult from={from} to={to} />
          </Suspense>
        )}
      </div>
    </div>
  );
}

async function PathResult({ from, to }: { from: string; to: string }) {
  try {
    const [path, dependents] = await Promise.all([
      findConnectionPath(from, to),
      getDependents(to, 18),
    ]);

    const route = path.rows[0];

    return (
      <div className="space-y-5">
        <Panel
          title="Shortest connection"
          description={`The fewest hops from ${from} to ${to} anywhere in this graph.`}
        >
          {route === undefined ? (
            <EmptyState
              icon="x"
              title="No route between them"
              description={`Nothing in ${from}'s dependency tree reaches ${to} within ten hops. They are genuinely unrelated in this dataset - which is itself a useful answer.`}
            />
          ) : (
            <div className="px-5 py-5">
              <p className="mb-4 text-[13.5px] leading-relaxed text-[var(--color-ink-muted)]">
                <Code>{to}</Code> is in your tree because{" "}
                <Code>{from}</Code> depends on it through{" "}
                <strong className="font-semibold text-[var(--color-ink)]">
                  {route.hops} hop{route.hops === 1 ? "" : "s"}
                </strong>
                .
              </p>

              <ol className="space-y-0">
                {route.keys.map((key, index) => {
                  const parsed = parseVersionKey(key);
                  const isFirst = index === 0;
                  const isLast = index === route.keys.length - 1;
                  const incomingScope = index > 0 ? route.scopes[index - 1] : undefined;
                  const incomingRange = index > 0 ? route.ranges[index - 1] : undefined;

                  return (
                    <li key={key}>
                      {/* The connector carries the declared range, which is the
                          part that makes the chain explanatory rather than just
                          a list: it shows what each package actually asked for. */}
                      {index > 0 && (
                        <div className="ml-[13px] flex items-center gap-2.5 border-l border-dashed border-[var(--color-line-strong)] py-1.5 pl-5">
                          <span className="font-mono text-[11px] text-[var(--color-ink-faint)]">
                            requires {incomingRange}
                          </span>
                          {incomingScope !== undefined && incomingScope !== "prod" && (
                            <Badge>{SCOPE_LABEL[incomingScope] ?? incomingScope}</Badge>
                          )}
                        </div>
                      )}

                      <div className="flex items-center gap-3">
                        <span
                          aria-hidden
                          className={
                            "flex h-[27px] w-[27px] shrink-0 items-center justify-center rounded-full border font-mono text-[11px] " +
                            (isFirst
                              ? "border-[var(--color-accent-dim)] bg-[var(--color-accent-ghost)] text-[var(--color-accent)]"
                              : isLast
                                ? "border-[color-mix(in_oklab,var(--color-moderate)_35%,transparent)] bg-[var(--color-moderate-ghost)] text-[var(--color-moderate)]"
                                : "border-[var(--color-line-strong)] bg-[var(--color-surface-raised)] text-[var(--color-ink-faint)]")
                          }
                        >
                          {index}
                        </span>

                        <Link
                          href={packageHref(parsed?.packageName ?? key, parsed?.version)}
                          className="font-mono text-[13.5px] text-[var(--color-ink)] transition-colors hover:text-[var(--color-accent)]"
                        >
                          {parsed?.packageName}
                          <span className="text-[var(--color-ink-faint)]">@{parsed?.version}</span>
                        </Link>
                      </div>
                    </li>
                  );
                })}
              </ol>
            </div>
          )}
          <QueryFootnote queryId="connection-path" serverMs={path.meta.consumedAfterMs} />
        </Panel>

        <Panel
          title={`Everything that pulls in ${to}`}
          description="The same relationship traversed backwards. In a graph this costs no more than going forwards; relationally it needs a second index and a second recursive query."
        >
          {dependents.rows.length === 0 ? (
            <EmptyState
              icon="o"
              title="Nothing depends on it here"
              description={`No package in this graph reaches ${to} within five hops.`}
            />
          ) : (
            <ul className="divide-y divide-[var(--color-line)]">
              {dependents.rows.map((row) => (
                <li key={row.packageName} className="flex items-center gap-3 px-5 py-2.5">
                  <Link
                    href={packageHref(row.packageName)}
                    className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-[var(--color-ink-muted)] transition-colors hover:text-[var(--color-ink)]"
                  >
                    {row.packageName}
                  </Link>
                  {row.isRoot && (
                    <Badge className="border-[color-mix(in_oklab,var(--color-accent)_28%,transparent)] bg-[var(--color-accent-ghost)] text-[var(--color-accent)]">
                      seeded
                    </Badge>
                  )}
                  <Badge>
                    {row.distance} hop{row.distance === 1 ? "" : "s"}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
          <QueryFootnote
            queryId="dependents"
            serverMs={dependents.meta.consumedAfterMs}
            rowCount={dependents.meta.rowCount}
          />
        </Panel>
      </div>
    );
  } catch (error) {
    return <DatabaseError error={toAppError(error)} />;
  }
}
