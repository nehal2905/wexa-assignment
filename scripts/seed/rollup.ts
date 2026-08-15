import { versionKey, type Severity } from "@/lib/graph/model";
import type { CrawlResult } from "./resolve";

/**
 * Seed-time rollups for the landing page.
 *
 * ## Why this exists
 *
 * The landing page shows thirty-one cards, each carrying the size of a package's
 * production dependency closure and the number of advisories reachable inside
 * it. Computing that live means thirty-one transitive closures per page load.
 * On a laptop-hosted Neo4j that takes about fifty milliseconds and looks fine;
 * on the CognoDB free tier — 0.5 burstable vCPU, and a server-side query
 * deadline around five seconds — it does not finish at all.
 *
 * The fix is the ordinary one: precompute the aggregate for the index, keep the
 * detail pages live. Every package page still runs the real traversal against
 * the graph; only the summary cards read stored numbers.
 *
 * ## Why it is computed here rather than in Cypher
 *
 * At this point in the pipeline the entire graph is already in memory as plain
 * objects. A breadth-first search over an adjacency map is linear, exact, and
 * about forty lines. Expressing the same thing as a Cypher query that the free
 * tier can actually execute would be considerably more contorted and no more
 * correct.
 *
 * The traversal rule is deliberately identical to the one the live queries use:
 * follow every edge whose scope is not `dev`. If the two ever diverged, the
 * landing page would disagree with the page it links to.
 */

const SEVERE: ReadonlySet<Severity> = new Set<Severity>(["CRITICAL", "HIGH"]);

export interface AdvisoryIndex {
  /** versionKey → advisory ids affecting it. */
  byVersion: Map<string, string[]>;
  /** advisory id → severity. */
  severityById: Map<string, Severity>;
}

/**
 * Fills in `prodDependencyCount`, `prodVulnerabilityCount` and
 * `prodSevereCount` on every root package, in place.
 */
export function computeRootRollups(crawl: CrawlResult, advisories: AdvisoryIndex): void {
  // Adjacency map over shipping edges only. Built once and reused across all
  // roots — rebuilding it per root would make this quadratic for no reason.
  const shipping = new Map<string, string[]>();
  for (const edge of crawl.dependsOn) {
    if (edge.scope === "dev") continue;
    const existing = shipping.get(edge.fromKey);
    if (existing === undefined) shipping.set(edge.fromKey, [edge.toKey]);
    else existing.push(edge.toKey);
  }

  for (const record of crawl.packages.values()) {
    if (!record.isRoot || record.rootVersion === null) continue;

    const start = versionKey(record.name, record.rootVersion);
    if (!crawl.versions.has(start)) continue;

    // Breadth-first, depth-capped to match the live queries' `*0..8` bound.
    // `seen` doubles as the cycle guard — npm graphs really do contain cycles.
    const seen = new Set<string>([start]);
    let frontier = [start];

    for (let depth = 0; depth < 8 && frontier.length > 0; depth += 1) {
      const next: string[] = [];
      for (const key of frontier) {
        for (const child of shipping.get(key) ?? []) {
          if (seen.has(child)) continue;
          seen.add(child);
          next.push(child);
        }
      }
      frontier = next;
    }

    const advisoryIds = new Set<string>();
    for (const key of seen) {
      for (const id of advisories.byVersion.get(key) ?? []) advisoryIds.add(id);
    }

    let severe = 0;
    for (const id of advisoryIds) {
      const severity = advisories.severityById.get(id);
      if (severity !== undefined && SEVERE.has(severity)) severe += 1;
    }

    // `seen` includes the root itself; the card reports dependencies, not the
    // package plus its dependencies.
    record.prodDependencyCount = seen.size - 1;
    record.prodVulnerabilityCount = advisoryIds.size;
    record.prodSevereCount = severe;
  }
}
