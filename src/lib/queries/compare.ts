import { cypher, int } from "@/lib/db/cypher";
import { readRows, type QueryMeta } from "@/lib/db/driver";
import { intToNumber } from "@/lib/db/serialize";
import { defineQuery } from "./define";

/**
 * Queries that relate two packages to each other rather than describing one.
 */

/* -------------------------------------------------------------------------- */
/* 1. Shared dependency footprint                                              */
/* -------------------------------------------------------------------------- */

export const COMPARE_FOOTPRINTS = defineQuery({
  id: "compare-footprints",
  group: "Comparison",
  title: "What two packages share, and what each drags in alone",
  question:
    "We're choosing between these two libraries. What does each one actually add to our install?",
  whyGraph:
    "This is a set operation over two transitive closures. In SQL you would need two " +
    "separate recursive CTEs, each materialising its own closure with its own cycle " +
    "guard, then a full outer join between them — and the query planner cannot help " +
    "much because neither side's size is known until it has been computed. In Cypher " +
    "each closure is one variable-length pattern and the comparison is three list " +
    "comprehensions over the results.",
  traversal: "1–8 shipping hops from each of the two roots, then set intersection and difference",
  parameters: [
    { name: "leftKey", description: "First version key", example: "express@4.17.1" },
    { name: "rightKey", description: "Second version key", example: "koa@2.16.2" },
  ],
  cypher: cypher`
    // Dev edges are excluded, and here that is a correctness requirement rather
    // than a preference. npm never installs a dependency's devDependencies — if
    // you add express to your project, express's own test and lint tooling does
    // not come with it. Counting those would answer a question nobody asked and
    // inflate both sides of the comparison with packages that never touch disk.
    MATCH (left:Version { key: $leftKey })-[leftHops:DEPENDS_ON*1..8]->(leftDep:Version)
    WHERE ALL(hop IN leftHops WHERE hop.scope <> 'dev')
    WITH collect(DISTINCT leftDep.packageName) AS leftPackages

    MATCH (right:Version { key: $rightKey })-[rightHops:DEPENDS_ON*1..8]->(rightDep:Version)
    WHERE ALL(hop IN rightHops WHERE hop.scope <> 'dev')
    WITH leftPackages, collect(DISTINCT rightDep.packageName) AS rightPackages

    RETURN [name IN leftPackages  WHERE name IN rightPackages]     AS shared,
           [name IN leftPackages  WHERE NOT name IN rightPackages] AS onlyLeft,
           [name IN rightPackages WHERE NOT name IN leftPackages]  AS onlyRight,
           size(leftPackages)  AS leftTotal,
           size(rightPackages) AS rightTotal
  `,
});

export interface FootprintComparison {
  shared: string[];
  onlyLeft: string[];
  onlyRight: string[];
  leftTotal: number;
  rightTotal: number;
}

export async function compareFootprints(
  leftKey: string,
  rightKey: string,
): Promise<{ rows: FootprintComparison[]; meta: QueryMeta }> {
  return readRows({
    statement: COMPARE_FOOTPRINTS.cypher,
    params: { leftKey, rightKey },
    label: COMPARE_FOOTPRINTS.id,
    map: (record) => ({
      shared: (record.get("shared") as string[]).sort(),
      onlyLeft: (record.get("onlyLeft") as string[]).sort(),
      onlyRight: (record.get("onlyRight") as string[]).sort(),
      leftTotal: intToNumber(record.get("leftTotal")),
      rightTotal: intToNumber(record.get("rightTotal")),
    }),
  });
}

/* -------------------------------------------------------------------------- */
/* 2. Connection between two packages                                          */
/* -------------------------------------------------------------------------- */

export const CONNECTION_PATH = defineQuery({
  id: "connection-path",
  group: "Comparison",
  title: "The shortest chain connecting one package to another",
  question: "Why on earth is this tiny library in my node_modules?",
  whyGraph:
    "The everyday version of this question — 'nothing in my package.json mentions " +
    "this, so who asked for it?' — is a shortest-path problem and nothing else. " +
    "Cypher answers it with one function call. The SQL equivalent is a breadth-first " +
    "search hand-written as a recursive CTE, and you still have to reassemble the " +
    "route yourself afterwards.",
  traversal: "1–10 hops, shortest path only",
  parameters: [
    { name: "fromName", description: "Package the search starts at", example: "express" },
    { name: "toName", description: "Package to reach", example: "ms" },
  ],
  cypher: cypher`
    MATCH (fromPkg:Package { name: $fromName })<-[:VERSION_OF]-(fromVersion:Version)
    MATCH (toPkg:Package   { name: $toName })<-[:VERSION_OF]-(toVersion:Version)
    MATCH path = shortestPath((fromVersion)-[:DEPENDS_ON*1..10]->(toVersion))

    RETURN [node IN nodes(path) | node.key]           AS keys,
           [node IN nodes(path) | node.packageName]   AS packages,
           [rel IN relationships(path) | rel.scope]   AS scopes,
           [rel IN relationships(path) | rel.range]   AS ranges,
           length(path)                               AS hops
    ORDER BY hops
    LIMIT 1
  `,
});

export interface ConnectionPath {
  keys: string[];
  packages: string[];
  scopes: string[];
  ranges: string[];
  hops: number;
}

export async function findConnectionPath(
  fromName: string,
  toName: string,
): Promise<{ rows: ConnectionPath[]; meta: QueryMeta }> {
  return readRows({
    statement: CONNECTION_PATH.cypher,
    params: { fromName, toName },
    label: CONNECTION_PATH.id,
    map: (record) => ({
      keys: record.get("keys") as string[],
      packages: record.get("packages") as string[],
      scopes: record.get("scopes") as string[],
      ranges: record.get("ranges") as string[],
      hops: intToNumber(record.get("hops")),
    }),
  });
}

/* -------------------------------------------------------------------------- */
/* 3. Dependents — the reverse direction                                       */
/* -------------------------------------------------------------------------- */

export const DEPENDENTS = defineQuery({
  id: "dependents",
  group: "Comparison",
  title: "Which packages in the graph depend on this one",
  question: "If this package broke tomorrow, who would notice?",
  whyGraph:
    "Traversing DEPENDS_ON backwards costs exactly the same as traversing it " +
    "forwards — relationships are navigable from both ends. The relational " +
    "equivalent needs a second index on the reverse key, and a second recursive " +
    "CTE written in the opposite direction.",
  traversal: "1–5 hops, reversed",
  parameters: [
    { name: "packageName", description: "Package to look up", example: "ms" },
    { name: "limit", description: "Maximum rows", example: "25" },
  ],
  cypher: cypher`
    MATCH (target:Package { name: $packageName })<-[:VERSION_OF]-(targetVersion:Version)

    // Bind and filter the dependent *before* the shortest-path call: a package
    // that transitively reaches itself through a cycle would otherwise make
    // shortestPath throw on identical endpoints.
    MATCH (dependent:Version)-[:DEPENDS_ON*1..5]->(targetVersion)
    WHERE dependent <> targetVersion

    MATCH (dependent)-[:VERSION_OF]->(dependentPackage:Package)
    MATCH path = shortestPath((dependent)-[:DEPENDS_ON*1..5]->(targetVersion))

    WITH dependentPackage, min(length(path)) AS distance
    RETURN dependentPackage.name            AS packageName,
           dependentPackage.weeklyDownloads AS weeklyDownloads,
           dependentPackage.isRoot          AS isRoot,
           distance
    ORDER BY distance, coalesce(dependentPackage.weeklyDownloads, 0) DESC
    LIMIT $limit
  `,
});

export interface Dependent {
  packageName: string;
  weeklyDownloads: number | null;
  isRoot: boolean;
  distance: number;
}

export async function getDependents(
  packageName: string,
  limit = 25,
): Promise<{ rows: Dependent[]; meta: QueryMeta }> {
  return readRows({
    statement: DEPENDENTS.cypher,
    params: { packageName, limit: int(limit) },
    label: DEPENDENTS.id,
    map: (record) => ({
      packageName: record.get("packageName") as string,
      weeklyDownloads: (() => {
        const value = record.get("weeklyDownloads") as unknown;
        return value === null ? null : intToNumber(value as never);
      })(),
      isRoot: (record.get("isRoot") as boolean | null) ?? false,
      distance: intToNumber(record.get("distance")),
    }),
  });
}
