import { cypher, int } from "@/lib/db/cypher";
import { readRows, type QueryMeta } from "@/lib/db/driver";
import { intToNumber } from "@/lib/db/serialize";
import { defineQuery } from "./define";

/**
 * Finding your way in: search, the landing page's root list, and the
 * graph-wide statistics shown on the About panel.
 */

/* -------------------------------------------------------------------------- */
/* Search                                                                      */
/* -------------------------------------------------------------------------- */

export const SEARCH_PACKAGES = defineQuery({
  id: "search-packages",
  group: "Discovery",
  title: "Search packages by name",
  question: "Which packages in the graph match what I'm typing?",
  whyGraph: null, // An index scan. A relational database would do this identically.
  traversal: "0 hops - a single indexed node scan",
  parameters: [
    { name: "term", description: "Lowercased search text", example: "expr" },
    { name: "limit", description: "Maximum rows to return", example: "12" },
  ],
  cypher: cypher`
    MATCH (p:Package)
    WHERE p.nameLower CONTAINS $term
    RETURN p.name            AS name,
           p.description     AS description,
           p.isRoot          AS isRoot,
           p.rootVersion     AS rootVersion,
           p.latestVersion   AS latestVersion,
           p.weeklyDownloads AS weeklyDownloads
    ORDER BY
      // Exact match first, then prefix matches, then everything else -
      // within each tier, the most-downloaded package wins.
      CASE
        WHEN p.nameLower = $term            THEN 0
        WHEN p.nameLower STARTS WITH $term  THEN 1
        ELSE 2
      END,
      coalesce(p.weeklyDownloads, 0) DESC,
      p.name
    LIMIT $limit
  `,
});

export interface PackageSearchHit {
  name: string;
  description: string | null;
  isRoot: boolean;
  rootVersion: string | null;
  latestVersion: string | null;
  weeklyDownloads: number | null;
}

export async function searchPackages(
  term: string,
  limit = 12,
): Promise<{ rows: PackageSearchHit[]; meta: QueryMeta }> {
  return readRows({
    statement: SEARCH_PACKAGES.cypher,
    params: { term: term.trim().toLowerCase(), limit: int(limit) },
    label: SEARCH_PACKAGES.id,
    map: (record) => ({
      name: record.get("name") as string,
      description: record.get("description") as string | null,
      isRoot: record.get("isRoot") as boolean,
      rootVersion: record.get("rootVersion") as string | null,
      latestVersion: record.get("latestVersion") as string | null,
      weeklyDownloads: (() => {
        const value = record.get("weeklyDownloads") as unknown;
        return value === null ? null : intToNumber(value as never);
      })(),
    }),
  });
}

/* -------------------------------------------------------------------------- */
/* Root packages (landing page)                                                */
/* -------------------------------------------------------------------------- */

export const LIST_ROOT_PACKAGES = defineQuery({
  id: "list-roots",
  group: "Discovery",
  title: "List seeded applications with their risk summary",
  question:
    "Which packages can I explore, and how much of a problem does each one have?",
  whyGraph: null, // A property read. The traversal behind these numbers happened at seed time.
  traversal: "0 hops - reads seed-time rollups, see the note below",
  parameters: [],
  cypher: cypher`
    // Deliberately not a traversal.
    //
    // These counts ARE the result of a transitive closure - one per card - but
    // computing thirty-one of them on every page load does not fit inside the
    // CognoDB free tier's query deadline. So the closure is computed once at
    // seed time by breadth-first search over the crawl result, using exactly the
    // production-scope rule the live queries use, and stored on the node.
    //
    // The index page reads rollups; every detail page it links to runs the real
    // traversal. That division is the normal shape of this problem, not a
    // shortcut - and it is stated plainly on the /queries page rather than being
    // dressed up as something it is not.
    MATCH (p:Package)
    WHERE p.isRoot = true AND p.rootVersion IS NOT NULL

    RETURN p.name                              AS name,
           p.rootVersion                       AS version,
           p.description                       AS description,
           p.rootBlurb                         AS blurb,
           p.rootCategory                      AS category,
           p.pinnedBecause                     AS pinnedBecause,
           p.weeklyDownloads                   AS weeklyDownloads,
           p.latestVersion                     AS latestVersion,
           coalesce(p.prodDependencyCount, 0)    AS dependencyCount,
           coalesce(p.prodVulnerabilityCount, 0) AS vulnerabilityCount,
           coalesce(p.prodSevereCount, 0)        AS severeCount
    ORDER BY vulnerabilityCount DESC, coalesce(p.weeklyDownloads, 0) DESC, p.name
  `,
});

export interface RootPackageSummary {
  name: string;
  version: string;
  description: string | null;
  blurb: string | null;
  category: string | null;
  pinnedBecause: string | null;
  weeklyDownloads: number | null;
  latestVersion: string | null;
  dependencyCount: number;
  vulnerabilityCount: number;
  severeCount: number;
}

export async function listRootPackages(): Promise<{
  rows: RootPackageSummary[];
  meta: QueryMeta;
}> {
  return readRows({
    statement: LIST_ROOT_PACKAGES.cypher,
    params: {},
    label: LIST_ROOT_PACKAGES.id,
    map: (record) => ({
      name: record.get("name") as string,
      version: record.get("version") as string,
      description: record.get("description") as string | null,
      blurb: record.get("blurb") as string | null,
      category: record.get("category") as string | null,
      pinnedBecause: record.get("pinnedBecause") as string | null,
      latestVersion: record.get("latestVersion") as string | null,
      weeklyDownloads: (() => {
        const value = record.get("weeklyDownloads") as unknown;
        return value === null ? null : intToNumber(value as never);
      })(),
      dependencyCount: intToNumber(record.get("dependencyCount")),
      vulnerabilityCount: intToNumber(record.get("vulnerabilityCount")),
      severeCount: intToNumber(record.get("severeCount")),
    }),
  });
}

/* -------------------------------------------------------------------------- */
/* Version resolution                                                          */
/* -------------------------------------------------------------------------- */

export const PACKAGE_VERSIONS = defineQuery({
  id: "package-versions",
  group: "Discovery",
  title: "Which versions of this package are in the graph",
  question: "This package appears more than once - which copies are actually here?",
  whyGraph:
    "Not a graph query in itself, but it exists *because* of one: the crawl resolves " +
    "every declared range independently, so a single package legitimately lands in " +
    "the graph at several concrete versions. This is the list of what was resolved.",
  traversal: "1 hop from :Package to its :Version nodes",
  parameters: [{ name: "name", description: "Package name", example: "lodash" }],
  cypher: cypher`
    MATCH (p:Package { name: $name })
    OPTIONAL MATCH (p)<-[:VERSION_OF]-(v:Version)
    RETURN p.name          AS name,
           p.rootVersion   AS rootVersion,
           p.latestVersion AS latestVersion,
           p.description   AS description,
           collect(DISTINCT v.version) AS versions
  `,
});

export interface PackageVersions {
  name: string;
  rootVersion: string | null;
  latestVersion: string | null;
  description: string | null;
  versions: string[];
}

export async function getPackageVersions(
  name: string,
): Promise<{ rows: PackageVersions[]; meta: QueryMeta }> {
  return readRows({
    statement: PACKAGE_VERSIONS.cypher,
    params: { name },
    label: PACKAGE_VERSIONS.id,
    map: (record) => ({
      name: record.get("name") as string,
      rootVersion: record.get("rootVersion") as string | null,
      latestVersion: record.get("latestVersion") as string | null,
      description: record.get("description") as string | null,
      versions: ((record.get("versions") as (string | null)[] | null) ?? []).filter(
        (value): value is string => value !== null,
      ),
    }),
  });
}

/* -------------------------------------------------------------------------- */
/* Graph statistics                                                            */
/* -------------------------------------------------------------------------- */

export const GRAPH_STATISTICS = defineQuery({
  id: "graph-statistics",
  group: "Discovery",
  title: "Count what is in the graph",
  question: "How big is this dataset?",
  whyGraph: null,
  traversal: "0 hops - label and relationship-type counts",
  parameters: [],
  cypher: cypher`
    MATCH (p:Package)          WITH count(p) AS packages
    MATCH (v:Version)          WITH packages, count(v) AS versions
    MATCH (m:Maintainer)       WITH packages, versions, count(m) AS maintainers
    MATCH (a:Vulnerability)    WITH packages, versions, maintainers, count(a) AS vulnerabilities
    MATCH (l:License)          WITH packages, versions, maintainers, vulnerabilities, count(l) AS licenses
    MATCH ()-[d:DEPENDS_ON]->() WITH packages, versions, maintainers, vulnerabilities, licenses,
                                     count(d) AS dependencyEdges
    MATCH ()-[f:AFFECTS]->()
    RETURN packages, versions, maintainers, vulnerabilities, licenses, dependencyEdges,
           count(f) AS advisoryEdges
  `,
});

export interface GraphStatistics {
  packages: number;
  versions: number;
  maintainers: number;
  vulnerabilities: number;
  licenses: number;
  dependencyEdges: number;
  advisoryEdges: number;
}

export async function getGraphStatistics(): Promise<{
  rows: GraphStatistics[];
  meta: QueryMeta;
}> {
  return readRows({
    statement: GRAPH_STATISTICS.cypher,
    params: {},
    label: GRAPH_STATISTICS.id,
    map: (record) => ({
      packages: intToNumber(record.get("packages")),
      versions: intToNumber(record.get("versions")),
      maintainers: intToNumber(record.get("maintainers")),
      vulnerabilities: intToNumber(record.get("vulnerabilities")),
      licenses: intToNumber(record.get("licenses")),
      dependencyEdges: intToNumber(record.get("dependencyEdges")),
      advisoryEdges: intToNumber(record.get("advisoryEdges")),
    }),
  });
}
