import { cypher, int } from "@/lib/db/cypher";
import { readRows, type QueryMeta } from "@/lib/db/driver";
import { intToNumber } from "@/lib/db/serialize";
import type { Severity } from "@/lib/graph/model";
import { defineQuery } from "./define";

/**
 * Vulnerability reachability - the queries this whole application exists for.
 *
 * The question a dependency audit actually needs answered is not "does this
 * package have a CVE" but "is there a route from the thing I ship to something
 * broken, and what is that route". That is a path query, and paths are what a
 * graph database returns natively.
 */

const ALL_SEVERITIES: Severity[] = ["CRITICAL", "HIGH", "MODERATE", "LOW", "UNKNOWN"];

/**
 * Which dependency scopes count as "reachable".
 *
 * This distinction is not cosmetic, and getting it wrong is how dependency
 * scanners earn their reputation for crying wolf. `express@4.17.1` reaches a
 * critical remote-code-execution advisory in `handlebars` - but only through
 * `hbs`, which is one of express's *devDependencies*. It is used to run
 * express's own test suite. It is never installed into your application and
 * never reaches production.
 *
 * Reporting that as "your app is vulnerable to RCE" would be false. Hiding it
 * entirely would also be wrong, because a compromised dev dependency still runs
 * on a maintainer's laptop and in CI. So both views exist and the UI makes the
 * active one obvious:
 *
 *  - `production` - only `prod` and `optional` edges. What you actually ship.
 *  - `all`        - includes `dev` edges. What a contributor's machine installs.
 */
export type ReachabilityScope = "production" | "all";

/* -------------------------------------------------------------------------- */
/* 1. Reachability paths                                                       */
/* -------------------------------------------------------------------------- */

export const VULNERABILITY_PATHS = defineQuery({
  id: "vulnerability-paths",
  group: "Vulnerability reachability",
  title: "Every route from this package to a known vulnerability",
  question:
    "My app depends on this. Which advisories can it actually reach, and through which chain of packages?",
  whyGraph:
    "This is the query a relational schema handles worst. The answer is a path of " +
    "unknown length, so SQL needs a recursive CTE that carries an array of visited " +
    "ids to break dependency cycles, re-joins the dependency table at every level, " +
    "and then still has to reconstruct the route by string-aggregating ids on the way " +
    "down. Cypher expresses the same thing as shortestPath over a variable-length " +
    "pattern, and hands back the path as a first-class value that we can read the " +
    "hops straight out of.",
  traversal: "0-8 hops, shortest path per (advisory, affected version) pair",
  parameters: [
    { name: "rootKey", description: "Version key to audit from", example: "express@4.17.1" },
    {
      name: "severities",
      description: "Severity bands to include",
      example: "['CRITICAL','HIGH']",
    },
  ],
  cypher: cypher`
    MATCH (root:Version { key: $rootKey })

    // Drive from the advisory side: only ~10% of versions carry one, so this is
    // a far smaller starting set than "every version reachable from the root".
    // Collapsing to DISTINCT versions first means one path search per affected
    // version rather than one per advisory edge.
    MATCH (:Vulnerability)-[:AFFECTS]->(candidate:Version)
    WITH root, collect(DISTINCT candidate) AS candidates
    UNWIND candidates AS target

    // Both endpoints are bound, so this runs as a bidirectional breadth-first
    // search rather than an enumeration of every path between them.
    //
    // The lower bound is 1, and the root is handled as its own case below,
    // because CognoDB's shortestPath does not return a zero-length path. With
    // *0..8 an advisory affecting the audited package itself would simply not
    // appear - silent under-reporting, in the one place it matters most.
    OPTIONAL MATCH found = shortestPath((root)-[:DEPENDS_ON*1..8]->(target))
    WITH root, target, CASE WHEN target = root THEN null ELSE found END AS path
    WHERE path IS NOT NULL OR target = root

    WITH target,
         CASE WHEN path IS NULL THEN 0 ELSE length(path) END AS depth,
         CASE WHEN path IS NULL THEN [root.key]
              ELSE [node IN nodes(path) | node.key] END AS pathKeys,
         CASE WHEN path IS NULL THEN []
              ELSE [rel IN relationships(path) | rel.scope] END AS pathScopes

    MATCH (vuln:Vulnerability)-[affects:AFFECTS]->(target)
    WHERE vuln.severity IN $severities

    RETURN vuln.id            AS id,
           vuln.severity      AS severity,
           vuln.cvssScore     AS cvssScore,
           vuln.summary       AS summary,
           vuln.url           AS url,
           vuln.aliases       AS aliases,
           target.key         AS targetKey,
           target.packageName AS targetPackage,
           target.version     AS targetVersion,
           affects.fixedIn    AS fixedIn,
           depth,
           pathKeys,
           pathScopes
    ORDER BY
      CASE vuln.severity
        WHEN 'CRITICAL' THEN 0
        WHEN 'HIGH'     THEN 1
        WHEN 'MODERATE' THEN 2
        WHEN 'LOW'      THEN 3
        ELSE 4
      END,
      coalesce(vuln.cvssScore, 0) DESC,
      depth,
      target.packageName
  `,
});

export interface VulnerabilityPath {
  id: string;
  severity: Severity;
  cvssScore: number | null;
  summary: string;
  url: string | null;
  aliases: string[];
  targetKey: string;
  targetPackage: string;
  targetVersion: string;
  fixedIn: string | null;
  /** 0 means the audited package is itself the vulnerable one. */
  depth: number;
  /** Version keys from the root through to the vulnerable package, inclusive. */
  pathKeys: string[];
  /** Dependency scope of each hop, aligned with the gaps in `pathKeys`. */
  pathScopes: string[];
}

/**
 * Production-only variant.
 *
 * The traversal itself is constrained rather than the results being filtered
 * afterwards, and the difference matters: `shortestPath` returns *the* shortest
 * route, so filtering after the fact would discard a package whose shortest
 * route happens to run through a dev edge even when a longer production route
 * also exists - a false negative, which is the worst kind of bug a security tool
 * can have. Putting `ALL(...)` inside the shortestPath's own WHERE lets the
 * planner evaluate the predicate during expansion, so it finds the shortest path
 * that satisfies the constraint.
 */
const VULNERABILITY_PATHS_PRODUCTION = cypher`
  MATCH (root:Version { key: $rootKey })

  // Collapse to DISTINCT affected versions before doing any path-finding.
  //
  // There are roughly three and a half advisory edges per affected version, so
  // driving path-finding straight off AFFECTS runs shortestPath ~460 times
  // instead of ~135 - the same answer at three times the cost. On the free tier
  // that was the difference between comfortably inside the query deadline and
  // sitting right on it. Advisories are re-attached after the paths are known.
  MATCH (:Vulnerability)-[:AFFECTS]->(candidate:Version)
  WITH root, collect(DISTINCT candidate) AS candidates
  UNWIND candidates AS target

  // Lower bound of 1 with the root handled separately - see the note on
  // VULNERABILITY_PATHS. An advisory on the audited package itself is always
  // in production scope, since reaching it requires no dependency edge at all.
  OPTIONAL MATCH found = shortestPath((root)-[:DEPENDS_ON*1..8]->(target))
  WHERE ALL(hop IN relationships(found) WHERE hop.scope <> 'dev')

  WITH root, target, CASE WHEN target = root THEN null ELSE found END AS path
  WHERE path IS NOT NULL OR target = root

  WITH target,
       CASE WHEN path IS NULL THEN 0 ELSE length(path) END AS depth,
       CASE WHEN path IS NULL THEN [root.key]
            ELSE [node IN nodes(path) | node.key] END AS pathKeys,
       CASE WHEN path IS NULL THEN []
            ELSE [rel IN relationships(path) | rel.scope] END AS pathScopes

  MATCH (vuln:Vulnerability)-[affects:AFFECTS]->(target)
  WHERE vuln.severity IN $severities

  RETURN vuln.id            AS id,
         vuln.severity      AS severity,
         vuln.cvssScore     AS cvssScore,
         vuln.summary       AS summary,
         vuln.url           AS url,
         vuln.aliases       AS aliases,
         target.key         AS targetKey,
         target.packageName AS targetPackage,
         target.version     AS targetVersion,
         affects.fixedIn    AS fixedIn,
         depth,
         pathKeys,
         pathScopes
  ORDER BY
    CASE vuln.severity
      WHEN 'CRITICAL' THEN 0
      WHEN 'HIGH'     THEN 1
      WHEN 'MODERATE' THEN 2
      WHEN 'LOW'      THEN 3
      ELSE 4
    END,
    coalesce(vuln.cvssScore, 0) DESC,
    depth,
    target.packageName
`;

export async function getVulnerabilityPaths(
  rootKey: string,
  severities: readonly Severity[] = ALL_SEVERITIES,
  scope: ReachabilityScope = "production",
): Promise<{ rows: VulnerabilityPath[]; meta: QueryMeta }> {
  return readRows({
    statement:
      scope === "production" ? VULNERABILITY_PATHS_PRODUCTION : VULNERABILITY_PATHS.cypher,
    params: { rootKey, severities: [...severities] },
    label: `${VULNERABILITY_PATHS.id}-${scope}`,
    map: (record) => ({
      id: record.get("id") as string,
      severity: record.get("severity") as Severity,
      cvssScore: record.get("cvssScore") as number | null,
      summary: record.get("summary") as string,
      url: record.get("url") as string | null,
      aliases: (record.get("aliases") as string[] | null) ?? [],
      targetKey: record.get("targetKey") as string,
      targetPackage: record.get("targetPackage") as string,
      targetVersion: record.get("targetVersion") as string,
      fixedIn: record.get("fixedIn") as string | null,
      depth: intToNumber(record.get("depth")),
      pathKeys: record.get("pathKeys") as string[],
      pathScopes: record.get("pathScopes") as string[],
    }),
  });
}

/* -------------------------------------------------------------------------- */
/* 2. Chokepoints - the actionable one                                         */
/* -------------------------------------------------------------------------- */

export const UPGRADE_CHOKEPOINTS = defineQuery({
  id: "upgrade-chokepoints",
  group: "Vulnerability reachability",
  title: "Which single direct dependency should I upgrade first",
  question:
    "I can only fix one thing today. Which of my direct dependencies sits between me and the most vulnerabilities?",
  whyGraph:
    "The answer is not a property of any package - it is a property of the routes " +
    "through it. We take the first hop of every vulnerability path and group by it, " +
    "which asks 'how much risk flows through this node'. There is no column anywhere " +
    "that holds this; it only exists once the paths have been computed, and computing " +
    "them is the part SQL cannot do cheaply.",
  traversal: "1-8 hops; groups every path by its first hop",
  parameters: [
    { name: "rootKey", description: "Version key to audit from", example: "express@4.17.1" },
    { name: "limit", description: "Maximum rows", example: "10" },
  ],
  cypher: cypher`
    MATCH (root:Version { key: $rootKey })
    MATCH (vuln:Vulnerability)-[:AFFECTS]->(target:Version)

    // shortestPath throws if its endpoints are the same node, and the root can
    // itself be one of the vulnerable versions. Filtering target before the
    // path-finding runs is what keeps that from being an error - and it is also
    // the right answer: if the root is the vulnerable package, there is no
    // intermediate dependency to upgrade, so it does not belong in this ranking.
    WHERE target <> root

    MATCH path = shortestPath((root)-[:DEPENDS_ON*1..8]->(target))

    // nodes(path)[1] is the first hop away from the root: one of the packages
    // named directly in the root's own package.json. When the path is a single
    // hop, that first node IS the vulnerable one.
    WITH vuln, target, nodes(path)[1] AS direct, length(path) AS depth
    WHERE direct IS NOT NULL

    RETURN direct.packageName          AS packageName,
           direct.version              AS version,
           count(DISTINCT vuln.id)     AS vulnerabilityCount,
           count(DISTINCT target.key)  AS vulnerablePackages,
           max(vuln.cvssScore)         AS worstScore,
           min(depth)                  AS shallowestDepth,
           size([s IN collect(DISTINCT vuln.severity) WHERE s IN ['CRITICAL','HIGH']]) > 0
                                       AS hasSevere,
           collect(DISTINCT target.packageName)[..6] AS examples
    ORDER BY vulnerabilityCount DESC, coalesce(worstScore, 0) DESC, packageName
    LIMIT $limit
  `,
});

export interface Chokepoint {
  packageName: string;
  version: string;
  vulnerabilityCount: number;
  vulnerablePackages: number;
  worstScore: number | null;
  shallowestDepth: number;
  hasSevere: boolean;
  examples: string[];
}

/** Production-only chokepoints - see the note on VULNERABILITY_PATHS_PRODUCTION. */
const UPGRADE_CHOKEPOINTS_PRODUCTION = cypher`
  MATCH (root:Version { key: $rootKey })

  // Same deduplication as the reachability query: find the paths once per
  // affected version, then fan back out to the advisories on each.
  MATCH (:Vulnerability)-[:AFFECTS]->(candidate:Version)
  WHERE candidate <> root
  WITH root, collect(DISTINCT candidate) AS candidates
  UNWIND candidates AS target

  MATCH path = shortestPath((root)-[:DEPENDS_ON*1..8]->(target))
  WHERE ALL(hop IN relationships(path) WHERE hop.scope <> 'dev')

  WITH target, nodes(path)[1] AS direct, length(path) AS depth
  WHERE direct IS NOT NULL

  MATCH (vuln:Vulnerability)-[:AFFECTS]->(target)

  RETURN direct.packageName          AS packageName,
         direct.version              AS version,
         count(DISTINCT vuln.id)     AS vulnerabilityCount,
         count(DISTINCT target.key)  AS vulnerablePackages,
         max(vuln.cvssScore)         AS worstScore,
         min(depth)                  AS shallowestDepth,
         size([s IN collect(DISTINCT vuln.severity) WHERE s IN ['CRITICAL','HIGH']]) > 0
                                     AS hasSevere,
         collect(DISTINCT target.packageName)[..6] AS examples
  ORDER BY vulnerabilityCount DESC, coalesce(worstScore, 0) DESC, packageName
  LIMIT $limit
`;

export async function getUpgradeChokepoints(
  rootKey: string,
  limit = 10,
  scope: ReachabilityScope = "production",
): Promise<{ rows: Chokepoint[]; meta: QueryMeta }> {
  return readRows({
    statement:
      scope === "production" ? UPGRADE_CHOKEPOINTS_PRODUCTION : UPGRADE_CHOKEPOINTS.cypher,
    params: { rootKey, limit: int(limit) },
    label: `${UPGRADE_CHOKEPOINTS.id}-${scope}`,
    map: (record) => ({
      packageName: record.get("packageName") as string,
      version: record.get("version") as string,
      vulnerabilityCount: intToNumber(record.get("vulnerabilityCount")),
      vulnerablePackages: intToNumber(record.get("vulnerablePackages")),
      worstScore: record.get("worstScore") as number | null,
      shallowestDepth: intToNumber(record.get("shallowestDepth")),
      hasSevere: record.get("hasSevere") as boolean,
      examples: record.get("examples") as string[],
    }),
  });
}
