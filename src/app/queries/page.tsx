import type { Metadata } from "next";
import { Suspense } from "react";

import { DatabaseError } from "@/components/database-error";
import { GraphModelDiagram } from "@/components/model-diagram";
import { Badge, Panel, SectionHeading, Skeleton } from "@/components/ui";
import { toAppError } from "@/lib/db/errors";
import { QUERY_CATALOG, QUERY_GROUPS, graphNativeCount, queriesInGroup } from "@/lib/queries/catalog";
import { getGraphStatistics } from "@/lib/queries/discovery";

/**
 * "How it works" — the data model and every Cypher statement the app runs.
 *
 * This page reads {@link QUERY_CATALOG}, the same array the API and the Server
 * Components execute. It is not a written-up copy of the queries: it is the
 * queries. Documentation maintained by hand drifts; documentation rendered from
 * the running code cannot.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "How it works",
  description:
    "The graph data model behind Understory and every Cypher query it runs, rendered from the application's own query catalog.",
};

export default function QueriesPage() {
  const graphNative = graphNativeCount();

  return (
    <div className="mx-auto max-w-[1100px] px-6 py-10">
      <SectionHeading
        eyebrow="How it works"
        title="The model, and every query that runs against it"
        description="Understory holds no data of its own — every panel in the application is a live Cypher query against CognoDB. This page is generated from the same query catalog the application executes, so it cannot describe a query the app no longer runs."
      />

      <Suspense fallback={<Skeleton className="h-20 w-full" />}>
        <StatsStrip />
      </Suspense>

      {/* --- Data model --------------------------------------------------- */}

      <section className="mt-12">
        <h2 className="text-lg font-semibold tracking-tight">The data model</h2>
        <p className="mt-2 max-w-3xl text-[13.5px] leading-relaxed text-[var(--color-ink-muted)]">
          Five node labels and six relationship types. One modelling decision does most of
          the work.
        </p>

        <div className="surface-card mt-5 overflow-x-auto p-6">
          <GraphModelDiagram />
        </div>

        <div className="mt-5 grid gap-4 md:grid-cols-2">
          <Panel title="Why DEPENDS_ON connects versions, not packages">
            <div className="space-y-3 px-5 py-4 text-[13px] leading-relaxed text-[var(--color-ink-muted)]">
              <p>
                A package.json records a <em>range</em> — <code className="font-mono text-[12px] text-[var(--color-ink)]">^4.17.0</code>{" "}
                — but what lands on disk is one concrete version. If the graph stored
                package-to-package edges, the central question of this application would be
                unanswerable: advisories apply to version ranges, so whether a path reaches
                something vulnerable depends entirely on which version each edge resolved to.
              </p>
              <p>
                So the seed script resolves every declared range with the same rule npm uses
                — the highest published version satisfying it — and stores an edge between
                two concrete <code className="font-mono text-[12px] text-[var(--color-ink)]">:Version</code> nodes,
                keeping the declared range as a property. That is what makes the reachability
                results truthful rather than approximate, and it is also what lets the tool
                spot a package installed at three versions at once.
              </p>
            </div>
          </Panel>

          <Panel title="What the model deliberately does not do">
            <div className="space-y-3 px-5 py-4 text-[13px] leading-relaxed text-[var(--color-ink-muted)]">
              <p>
                <strong className="font-medium text-[var(--color-ink)]">Peer dependencies are not traversed.</strong>{" "}
                Peer ranges are intentionally wide, and following them pulls entire framework
                trees into the graph on evidence that does not support it. They are counted,
                not walked.
              </p>
              <p>
                <strong className="font-medium text-[var(--color-ink)]">devDependencies are followed only from a root.</strong>{" "}
                That mirrors npm exactly: a package's dev dependencies are installed when it
                is the project you are building, never when it is something you depend on.
              </p>
              <p>
                <strong className="font-medium text-[var(--color-ink)]">Resolution assumes no lockfile.</strong>{" "}
                Results describe what a fresh install would produce today, not what any
                particular project has pinned.
              </p>
            </div>
          </Panel>
        </div>
      </section>

      {/* --- Queries ------------------------------------------------------- */}

      <section className="mt-14">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold tracking-tight">The queries</h2>
            <p className="mt-2 max-w-3xl text-[13.5px] leading-relaxed text-[var(--color-ink-muted)]">
              {QUERY_CATALOG.length} statements, of which {graphNative} make a specific claim
              about being better as a traversal than as a join. The other{" "}
              {QUERY_CATALOG.length - graphNative} are ordinary lookups — a relational
              database would handle those perfectly well, and saying otherwise would be
              dishonest.
            </p>
          </div>
        </div>

        <div className="mt-6 space-y-10">
          {QUERY_GROUPS.map((group) => {
            const queries = queriesInGroup(group);
            if (queries.length === 0) return null;

            return (
              <div key={group}>
                <h3 className="mb-4 font-mono text-[11px] uppercase tracking-[0.16em] text-[var(--color-accent)]">
                  {group}
                </h3>
                <div className="space-y-4">
                  {queries.map((query) => (
                    <article key={query.id} id={query.id} className="surface-card scroll-mt-20">
                      <header className="border-b border-[var(--color-line)] px-5 py-4">
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0">
                            <h4 className="text-[14px] font-semibold tracking-tight">
                              {query.title}
                            </h4>
                            <p className="mt-1 text-[13px] italic leading-relaxed text-[var(--color-ink-muted)]">
                              “{query.question}”
                            </p>
                          </div>
                          <Badge className="shrink-0">{query.id}</Badge>
                        </div>

                        <p className="mt-3 font-mono text-[11px] text-[var(--color-ink-faint)]">
                          {query.traversal}
                        </p>
                      </header>

                      {query.whyGraph !== null ? (
                        <div className="border-b border-[var(--color-line)] bg-[var(--color-accent-ghost)]/25 px-5 py-3.5">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--color-accent)]">
                            Why a graph
                          </p>
                          <p className="mt-1.5 text-[13px] leading-relaxed text-[var(--color-ink-muted)]">
                            {query.whyGraph}
                          </p>
                        </div>
                      ) : (
                        <div className="border-b border-[var(--color-line)] px-5 py-2.5">
                          <p className="text-[12px] text-[var(--color-ink-faint)]">
                            An indexed lookup. A relational database would do this identically —
                            no graph advantage claimed.
                          </p>
                        </div>
                      )}

                      {query.parameters.length > 0 && (
                        <div className="border-b border-[var(--color-line)] px-5 py-3">
                          <p className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--color-ink-faint)]">
                            Parameters
                          </p>
                          <dl className="mt-2 space-y-1">
                            {query.parameters.map((parameter) => (
                              <div key={parameter.name} className="flex flex-wrap items-baseline gap-2">
                                <dt className="font-mono text-[12px] text-[var(--color-accent)]">
                                  ${parameter.name}
                                </dt>
                                <dd className="text-[12.5px] text-[var(--color-ink-muted)]">
                                  {parameter.description}
                                  <span className="ml-2 font-mono text-[11.5px] text-[var(--color-ink-faint)]">
                                    e.g. {parameter.example}
                                  </span>
                                </dd>
                              </div>
                            ))}
                          </dl>
                        </div>
                      )}

                      <pre className="overflow-x-auto px-5 py-4 font-mono text-[12px] leading-[1.7] text-[var(--color-ink-muted)]">
                        <code>{query.cypher.trim()}</code>
                      </pre>
                    </article>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      {/* --- Safety note --------------------------------------------------- */}

      <section className="mt-14">
        <Panel title="Every statement above is a static literal">
          <div className="space-y-3 px-5 py-4 text-[13px] leading-relaxed text-[var(--color-ink-muted)]">
            <p>
              None of the Cypher on this page is assembled at runtime. Statements are
              declared with a tagged template that throws on any interpolation, and they
              carry a branded type that a plain <code className="font-mono text-[12px] text-[var(--color-ink)]">string</code>{" "}
              cannot satisfy — so the query executor accepts nothing else. An attempt to
              build Cypher by concatenation fails at module load, not in production.
            </p>
            <p>
              Values reach the database as Bolt parameters, out of band from the statement
              text, where they cannot alter its structure. The one thing that genuinely
              cannot be a parameter is a variable-length bound — Cypher rejects{" "}
              <code className="font-mono text-[12px] text-[var(--color-ink)]">*1..$depth</code>{" "}
              as a syntax error — so the traversal depths the interface offers exist as a
              small set of separate static statements chosen by an exhaustive switch.
            </p>
          </div>
        </Panel>
      </section>
    </div>
  );
}

async function StatsStrip() {
  try {
    const { rows, meta } = await getGraphStatistics();
    const stats = rows[0];
    if (stats === undefined) return null;

    const items: Array<[string, number]> = [
      ["Package", stats.packages],
      ["Version", stats.versions],
      ["Maintainer", stats.maintainers],
      ["Vulnerability", stats.vulnerabilities],
      ["License", stats.licenses],
      ["DEPENDS_ON", stats.dependencyEdges],
      ["AFFECTS", stats.advisoryEdges],
    ];

    return (
      <div className="surface-card mt-6 px-5 py-4">
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--color-ink-faint)]">
          Currently in the graph
        </p>
        <div className="flex flex-wrap gap-2">
          {items.map(([label, count]) => (
            <Badge key={label}>
              {label}
              <span className="tabular ml-1 text-[var(--color-ink)]">
                {count.toLocaleString("en-US")}
              </span>
            </Badge>
          ))}
        </div>
        <p className="mt-3 font-mono text-[11px] text-[var(--color-ink-faint)]">
          counted live · {meta.consumedAfterMs} ms
        </p>
      </div>
    );
  } catch (error) {
    return <DatabaseError error={toAppError(error)} />;
  }
}
