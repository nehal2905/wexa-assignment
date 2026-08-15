import { cypher, int, type Cypher } from "@/lib/db/cypher";
import { readRows, type QueryMeta } from "@/lib/db/driver";
import { intToNumber } from "@/lib/db/serialize";
import type { Severity } from "@/lib/graph/model";
import { defineQuery } from "./define";

/**
 * The package header and the data behind the force-directed visualisation.
 */

/* -------------------------------------------------------------------------- */
/* 1. Overview                                                                 */
/* -------------------------------------------------------------------------- */

export const PACKAGE_OVERVIEW = defineQuery({
  id: "package-overview",
  group: "Dependency tree",
  title: "Headline figures for one package version",
  question: "What am I looking at, and how bad is it?",
  whyGraph:
    "Every number on this panel except the package's own metadata is a property of " +
    "the closure beneath it - total dependencies, deepest chain, how many carry " +
    "advisories. All of them come from one traversal.",
  traversal: "0-8 hops, aggregated",
  parameters: [
    { name: "rootKey", description: "Version key", example: "express@4.17.1" },
  ],
  cypher: cypher`
    MATCH (root:Version { key: $rootKey })-[:VERSION_OF]->(pkg:Package)
    OPTIONAL MATCH (root)-[:LICENSED_UNDER]->(ownLicense:License)

    // Direct dependencies - one hop only.
    OPTIONAL MATCH (root)-[:DEPENDS_ON]->(direct:Version)
    WITH root, pkg, ownLicense, count(DISTINCT direct) AS directCount

    // One traversal produces the whole closure *and* each member's distance.
    //
    // The root is prepended explicitly rather than relying on a zero lower
    // bound: CognoDB's shortestPath does not return the zero-length path, so
    // *0..8 would omit the audited package from its own totals. See the note
    // above NODES_DEPTH_1.
    OPTIONAL MATCH path = shortestPath((root)-[:DEPENDS_ON*1..8]->(other:Version))
    WITH root, pkg, ownLicense, directCount,
         collect({ node: other, depth: length(path) }) AS others

    UNWIND ([{ node: root, depth: 0 }] + others) AS entry
    WITH root, pkg, ownLicense, directCount,
         entry.node AS member, entry.depth AS depth
    WHERE member IS NOT NULL

    OPTIONAL MATCH (member)<-[:AFFECTS]-(vuln:Vulnerability)
    WITH root, pkg, ownLicense, directCount,
         collect(DISTINCT member) AS members,
         max(depth)               AS deepestChain,
         collect(DISTINCT vuln)   AS advisories

    WITH root, pkg, ownLicense, directCount, members, deepestChain, advisories,
         size([m IN members WHERE m.deprecated IS NOT NULL AND m.key <> root.key])
           AS deprecatedCount

    RETURN pkg.name             AS name,
           root.key             AS key,
           root.version         AS version,
           pkg.description      AS description,
           pkg.repository       AS repository,
           pkg.homepage         AS homepage,
           pkg.latestVersion    AS latestVersion,
           pkg.weeklyDownloads  AS weeklyDownloads,
           pkg.isRoot           AS isRoot,
           pkg.pinnedBecause    AS pinnedBecause,
           root.publishedAt     AS publishedAt,
           root.deprecated      AS deprecated,
           root.unpackedSize    AS unpackedSize,
           ownLicense.spdxId    AS license,
           directCount          AS directDependencies,
           // members includes the root itself at depth 0 - subtract it.
           size(members) - 1    AS totalDependencies,
           deepestChain,
           deprecatedCount,
           size(advisories)     AS vulnerabilityCount,
           size([v IN advisories WHERE v.severity = 'CRITICAL']) AS criticalCount,
           size([v IN advisories WHERE v.severity = 'HIGH'])     AS highCount,
           size([v IN advisories WHERE v.severity = 'MODERATE']) AS moderateCount,
           size([v IN advisories WHERE v.severity = 'LOW'])      AS lowCount
  `,
});

export interface PackageOverview {
  name: string;
  key: string;
  version: string;
  description: string | null;
  repository: string | null;
  homepage: string | null;
  latestVersion: string | null;
  weeklyDownloads: number | null;
  isRoot: boolean;
  pinnedBecause: string | null;
  publishedAt: string | null;
  deprecated: string | null;
  unpackedSize: number | null;
  license: string | null;
  directDependencies: number;
  totalDependencies: number;
  deepestChain: number;
  deprecatedCount: number;
  vulnerabilityCount: number;
  criticalCount: number;
  highCount: number;
  moderateCount: number;
  lowCount: number;
}

function optionalInt(value: unknown): number | null {
  return value === null || value === undefined ? null : intToNumber(value as never);
}

/**
 * Production-scoped overview.
 *
 * The header figures have to agree with the panels underneath them. Showing "52
 * advisories" above a list containing eleven, because the headline counted
 * devDependencies and the list did not, is the kind of internal contradiction
 * that makes a reader stop believing any number on the page.
 *
 * The only difference from the unrestricted statement is the `ALL(...)`
 * predicate constraining the traversal - the same technique used by the
 * reachability queries, and covered by the same invariant check in
 * `scripts/verify-queries.ts`.
 */
const PACKAGE_OVERVIEW_PRODUCTION = cypher`
  MATCH (root:Version { key: $rootKey })-[:VERSION_OF]->(pkg:Package)
  OPTIONAL MATCH (root)-[:LICENSED_UNDER]->(ownLicense:License)

  OPTIONAL MATCH (root)-[declared:DEPENDS_ON]->(direct:Version)
  WHERE declared.scope <> 'dev'
  WITH root, pkg, ownLicense, count(DISTINCT direct) AS directCount

  OPTIONAL MATCH path = shortestPath((root)-[:DEPENDS_ON*1..8]->(other:Version))
  WHERE ALL(hop IN relationships(path) WHERE hop.scope <> 'dev')
  WITH root, pkg, ownLicense, directCount,
       collect({ node: other, depth: length(path) }) AS others

  UNWIND ([{ node: root, depth: 0 }] + others) AS entry
  WITH root, pkg, ownLicense, directCount,
       entry.node AS member, entry.depth AS depth
  WHERE member IS NOT NULL

  OPTIONAL MATCH (member)<-[:AFFECTS]-(vuln:Vulnerability)
  WITH root, pkg, ownLicense, directCount,
       collect(DISTINCT member) AS members,
       max(depth)               AS deepestChain,
       collect(DISTINCT vuln)   AS advisories

  WITH root, pkg, ownLicense, directCount, members, deepestChain, advisories,
       size([m IN members WHERE m.deprecated IS NOT NULL AND m.key <> root.key])
         AS deprecatedCount

  RETURN pkg.name             AS name,
         root.key             AS key,
         root.version         AS version,
         pkg.description      AS description,
         pkg.repository       AS repository,
         pkg.homepage         AS homepage,
         pkg.latestVersion    AS latestVersion,
         pkg.weeklyDownloads  AS weeklyDownloads,
         pkg.isRoot           AS isRoot,
         pkg.pinnedBecause    AS pinnedBecause,
         root.publishedAt     AS publishedAt,
         root.deprecated      AS deprecated,
         root.unpackedSize    AS unpackedSize,
         ownLicense.spdxId    AS license,
         directCount          AS directDependencies,
         size(members) - 1    AS totalDependencies,
         deepestChain,
         deprecatedCount,
         size(advisories)     AS vulnerabilityCount,
         size([v IN advisories WHERE v.severity = 'CRITICAL']) AS criticalCount,
         size([v IN advisories WHERE v.severity = 'HIGH'])     AS highCount,
         size([v IN advisories WHERE v.severity = 'MODERATE']) AS moderateCount,
         size([v IN advisories WHERE v.severity = 'LOW'])      AS lowCount
`;

export async function getPackageOverview(
  rootKey: string,
  scope: "production" | "all" = "production",
): Promise<{ rows: PackageOverview[]; meta: QueryMeta }> {
  return readRows({
    statement: scope === "production" ? PACKAGE_OVERVIEW_PRODUCTION : PACKAGE_OVERVIEW.cypher,
    params: { rootKey },
    label: `${PACKAGE_OVERVIEW.id}-${scope}`,
    map: (record) => ({
      name: record.get("name") as string,
      key: record.get("key") as string,
      version: record.get("version") as string,
      description: record.get("description") as string | null,
      repository: record.get("repository") as string | null,
      homepage: record.get("homepage") as string | null,
      latestVersion: record.get("latestVersion") as string | null,
      weeklyDownloads: optionalInt(record.get("weeklyDownloads")),
      isRoot: (record.get("isRoot") as boolean | null) ?? false,
      pinnedBecause: record.get("pinnedBecause") as string | null,
      publishedAt: record.get("publishedAt") as string | null,
      deprecated: record.get("deprecated") as string | null,
      unpackedSize: optionalInt(record.get("unpackedSize")),
      license: record.get("license") as string | null,
      directDependencies: intToNumber(record.get("directDependencies")),
      totalDependencies: intToNumber(record.get("totalDependencies")),
      deepestChain: intToNumber(record.get("deepestChain")),
      deprecatedCount: intToNumber(record.get("deprecatedCount")),
      vulnerabilityCount: intToNumber(record.get("vulnerabilityCount")),
      criticalCount: intToNumber(record.get("criticalCount")),
      highCount: intToNumber(record.get("highCount")),
      moderateCount: intToNumber(record.get("moderateCount")),
      lowCount: intToNumber(record.get("lowCount")),
    }),
  });
}

/* -------------------------------------------------------------------------- */
/* 2. Visualisation subgraph                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Depth is a literal in each statement, not a parameter.
 *
 * Cypher does not accept a parameter as a variable-length bound - `*1..$depth`
 * is a syntax error, not a slow query. The alternative would be building the
 * statement by concatenation, which this codebase forbids by construction (see
 * `db/cypher.ts`). So the four depths the UI offers are four static statements,
 * chosen by an exhaustive switch. Four near-identical strings is a small price
 * for the guarantee that no user input ever reaches the parser.
 *
 * ## Why the root is added by hand
 *
 * The obvious spelling is `shortestPath((root)-[:DEPENDS_ON*0..N]->(node))`,
 * where a lower bound of zero is supposed to yield the start node itself at
 * depth 0. Neo4j does that. CognoDB does not - it returns only paths of length
 * one or more, so the audited package was silently absent from its own graph.
 *
 * That is not a cosmetic difference. The same spelling appears in the
 * reachability and licence queries, where a missing root means advisories and
 * obligations *on the package you are auditing* go unreported - the one failure
 * mode a security tool must never have. (`express@4.17.1` carries two advisories
 * itself; before this fix, neither appeared.)
 *
 * So every traversal that needs to include its own starting point now uses a
 * lower bound of one and prepends the root explicitly. It is more verbose, it
 * behaves identically on both engines, and it cannot silently under-report.
 */
const NODES_DEPTH_1 = cypher`
  MATCH (root:Version { key: $rootKey })

  OPTIONAL MATCH path = shortestPath((root)-[:DEPENDS_ON*1..1]->(other:Version))
  WITH root, collect({ node: other, depth: length(path) }) AS others

  // The root is prepended rather than relying on a zero lower bound.
  UNWIND ([{ node: root, depth: 0 }] + others) AS entry
  WITH entry.node AS node, entry.depth AS depth
  WHERE node IS NOT NULL

  OPTIONAL MATCH (node)<-[:AFFECTS]-(vuln:Vulnerability)
  RETURN node.key AS key, node.packageName AS packageName, node.version AS version,
         depth, node.deprecated IS NOT NULL AS deprecated,
         count(vuln) AS vulnerabilityCount,
         collect(DISTINCT vuln.severity) AS severities
  ORDER BY depth, packageName
  LIMIT $limit
`;

const NODES_DEPTH_2 = cypher`
  MATCH (root:Version { key: $rootKey })

  OPTIONAL MATCH path = shortestPath((root)-[:DEPENDS_ON*1..2]->(other:Version))
  WITH root, collect({ node: other, depth: length(path) }) AS others

  // The root is prepended rather than relying on a zero lower bound.
  UNWIND ([{ node: root, depth: 0 }] + others) AS entry
  WITH entry.node AS node, entry.depth AS depth
  WHERE node IS NOT NULL

  OPTIONAL MATCH (node)<-[:AFFECTS]-(vuln:Vulnerability)
  RETURN node.key AS key, node.packageName AS packageName, node.version AS version,
         depth, node.deprecated IS NOT NULL AS deprecated,
         count(vuln) AS vulnerabilityCount,
         collect(DISTINCT vuln.severity) AS severities
  ORDER BY depth, packageName
  LIMIT $limit
`;

const NODES_DEPTH_3 = cypher`
  MATCH (root:Version { key: $rootKey })

  OPTIONAL MATCH path = shortestPath((root)-[:DEPENDS_ON*1..3]->(other:Version))
  WITH root, collect({ node: other, depth: length(path) }) AS others

  // The root is prepended rather than relying on a zero lower bound.
  UNWIND ([{ node: root, depth: 0 }] + others) AS entry
  WITH entry.node AS node, entry.depth AS depth
  WHERE node IS NOT NULL

  OPTIONAL MATCH (node)<-[:AFFECTS]-(vuln:Vulnerability)
  RETURN node.key AS key, node.packageName AS packageName, node.version AS version,
         depth, node.deprecated IS NOT NULL AS deprecated,
         count(vuln) AS vulnerabilityCount,
         collect(DISTINCT vuln.severity) AS severities
  ORDER BY depth, packageName
  LIMIT $limit
`;

const NODES_DEPTH_4 = cypher`
  MATCH (root:Version { key: $rootKey })

  OPTIONAL MATCH path = shortestPath((root)-[:DEPENDS_ON*1..4]->(other:Version))
  WITH root, collect({ node: other, depth: length(path) }) AS others

  // The root is prepended rather than relying on a zero lower bound.
  UNWIND ([{ node: root, depth: 0 }] + others) AS entry
  WITH entry.node AS node, entry.depth AS depth
  WHERE node IS NOT NULL

  OPTIONAL MATCH (node)<-[:AFFECTS]-(vuln:Vulnerability)
  RETURN node.key AS key, node.packageName AS packageName, node.version AS version,
         depth, node.deprecated IS NOT NULL AS deprecated,
         count(vuln) AS vulnerabilityCount,
         collect(DISTINCT vuln.severity) AS severities
  ORDER BY depth, packageName
  LIMIT $limit
`;

export type GraphDepth = 1 | 2 | 3 | 4;

function nodeStatementFor(depth: GraphDepth): Cypher {
  switch (depth) {
    case 1:
      return NODES_DEPTH_1;
    case 2:
      return NODES_DEPTH_2;
    case 3:
      return NODES_DEPTH_3;
    case 4:
      return NODES_DEPTH_4;
  }
}

export const DEPENDENCY_GRAPH_NODES = defineQuery({
  id: "dependency-graph-nodes",
  group: "Dependency tree",
  title: "The dependency subgraph, with each node's distance from the root",
  question: "Show me the shape of what I'm installing.",
  whyGraph:
    "The visualisation needs each node's shortest distance from the root, which is " +
    "the length of a path - a value that does not exist until the graph has been " +
    "walked. There is no column to select it from.",
  traversal: "0-4 hops, selectable; one static statement per depth",
  parameters: [
    { name: "rootKey", description: "Version key", example: "express@4.17.1" },
    { name: "limit", description: "Node ceiling, to keep the canvas readable", example: "400" },
  ],
  cypher: NODES_DEPTH_3,
});

export const DEPENDENCY_GRAPH_EDGES = defineQuery({
  id: "dependency-graph-edges",
  group: "Dependency tree",
  title: "Edges between the nodes already selected",
  question: "How do those packages connect to each other?",
  whyGraph:
    "Fetched as a second statement rather than bundled into the first: collecting " +
    "nodes and their interconnections in one query means carrying the node list " +
    "through an UNWIND and re-matching against it, which is both slower and much " +
    "harder to read than two focused statements.",
  traversal: "1 hop, restricted to a known node set",
  parameters: [
    { name: "keys", description: "Version keys already on the canvas", example: "['express@4.17.1']" },
  ],
  cypher: cypher`
    MATCH (from:Version)-[dependency:DEPENDS_ON]->(to:Version)
    WHERE from.key IN $keys AND to.key IN $keys
    RETURN from.key         AS fromKey,
           to.key           AS toKey,
           dependency.range AS range,
           dependency.scope AS scope
  `,
});

export interface GraphNode {
  key: string;
  packageName: string;
  version: string;
  depth: number;
  deprecated: boolean;
  vulnerabilityCount: number;
  severities: Severity[];
}

export interface GraphEdge {
  fromKey: string;
  toKey: string;
  range: string;
  scope: string;
}

export async function getDependencyGraph(
  rootKey: string,
  depth: GraphDepth = 3,
  limit = 400,
): Promise<{ nodes: GraphNode[]; edges: GraphEdge[]; meta: QueryMeta }> {
  const nodeResult = await readRows({
    statement: nodeStatementFor(depth),
    params: { rootKey, limit: int(limit) },
    label: `${DEPENDENCY_GRAPH_NODES.id}-d${depth}`,
    map: (record) => ({
      key: record.get("key") as string,
      packageName: record.get("packageName") as string,
      version: record.get("version") as string,
      depth: intToNumber(record.get("depth")),
      deprecated: record.get("deprecated") as boolean,
      vulnerabilityCount: intToNumber(record.get("vulnerabilityCount")),
      severities: ((record.get("severities") as (Severity | null)[] | null) ?? []).filter(
        (value): value is Severity => value !== null,
      ),
    }),
  });

  if (nodeResult.rows.length === 0) {
    return { nodes: [], edges: [], meta: nodeResult.meta };
  }

  const edgeResult = await readRows({
    statement: DEPENDENCY_GRAPH_EDGES.cypher,
    params: { keys: nodeResult.rows.map((node) => node.key) },
    label: DEPENDENCY_GRAPH_EDGES.id,
    map: (record) => ({
      fromKey: record.get("fromKey") as string,
      toKey: record.get("toKey") as string,
      range: record.get("range") as string,
      scope: record.get("scope") as string,
    }),
  });

  return {
    nodes: nodeResult.rows,
    edges: edgeResult.rows,
    // Report the combined server time so the UI's "queried in Nms" is honest.
    meta: {
      availableAfterMs: nodeResult.meta.availableAfterMs + edgeResult.meta.availableAfterMs,
      consumedAfterMs: nodeResult.meta.consumedAfterMs + edgeResult.meta.consumedAfterMs,
      roundTripMs: nodeResult.meta.roundTripMs + edgeResult.meta.roundTripMs,
      rowCount: nodeResult.meta.rowCount + edgeResult.meta.rowCount,
    },
  };
}
