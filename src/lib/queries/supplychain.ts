import { cypher, int } from "@/lib/db/cypher";
import { readRows, type QueryMeta } from "@/lib/db/driver";
import { intToNumber } from "@/lib/db/serialize";
import type { LicenseCategory } from "@/lib/graph/model";
import { defineQuery } from "./define";

/**
 * Supply-chain trust and hygiene: who controls your tree, what you are obliged
 * to comply with, and where the tree is duplicating itself.
 */

/* -------------------------------------------------------------------------- */
/* 1. Maintainer blast radius                                                  */
/* -------------------------------------------------------------------------- */

export const MAINTAINER_BLAST_RADIUS = defineQuery({
  id: "maintainer-blast-radius",
  group: "Supply-chain trust",
  title: "Whose npm account could compromise the most of my tree",
  question:
    "If one maintainer's account were taken over, how much of what I install could they change?",
  whyGraph:
    "This walks two different relationship types in one pattern: down the dependency " +
    "tree an unknown number of hops, then sideways from each package to the people who " +
    "can publish it. The join key changes halfway through the traversal. In SQL that is " +
    "a recursive CTE feeding a second join against a many-to-many table, materialising " +
    "the whole closure before it can group. Here the traversal and the pivot are the " +
    "same pattern.",
  traversal: "0-8 hops down DEPENDS_ON, then 2 hops out via VERSION_OF and MAINTAINS",
  parameters: [
    { name: "rootKey", description: "Version key to audit from", example: "express@4.17.1" },
    { name: "limit", description: "Maximum maintainers", example: "15" },
  ],
  cypher: cypher`
    MATCH (root:Version { key: $rootKey })
    MATCH (root)-[:DEPENDS_ON*0..8]->(reachable:Version)
    WITH DISTINCT reachable

    MATCH (reachable)-[:VERSION_OF]->(pkg:Package)<-[:MAINTAINS]-(person:Maintainer)
    WITH person,
         collect(DISTINCT pkg.name) AS packages

    RETURN person.username        AS username,
           person.email           AS email,
           size(packages)         AS packageCount,
           packages[..8]          AS examples
    ORDER BY packageCount DESC, username
    LIMIT $limit
  `,
});

export interface MaintainerReach {
  username: string;
  email: string | null;
  packageCount: number;
  examples: string[];
}

export async function getMaintainerBlastRadius(
  rootKey: string,
  limit = 15,
): Promise<{ rows: MaintainerReach[]; meta: QueryMeta }> {
  return readRows({
    statement: MAINTAINER_BLAST_RADIUS.cypher,
    params: { rootKey, limit: int(limit) },
    label: MAINTAINER_BLAST_RADIUS.id,
    map: (record) => ({
      username: record.get("username") as string,
      email: record.get("email") as string | null,
      packageCount: intToNumber(record.get("packageCount")),
      examples: record.get("examples") as string[],
    }),
  });
}

/* -------------------------------------------------------------------------- */
/* 2. License exposure                                                         */
/* -------------------------------------------------------------------------- */

export const LICENSE_EXPOSURE = defineQuery({
  id: "license-exposure",
  group: "Licensing",
  title: "What am I obliged to comply with, and how deep is it buried",
  question:
    "Is there anything in my dependency tree with license terms that would surprise my legal team?",
  whyGraph:
    "The interesting part is not which licenses appear but how far down they are. A " +
    "GPL dependency you chose is a decision; the same license arriving at depth five " +
    "through three packages you have never heard of is a discovery. Reporting the " +
    "shallowest depth per license requires the distance along the path, which only " +
    "exists once you have traversed it.",
  traversal: "0-8 hops, keeping the minimum distance at which each license appears",
  parameters: [
    { name: "rootKey", description: "Version key to audit from", example: "express@4.17.1" },
  ],
  cypher: cypher`
    MATCH (root:Version { key: $rootKey })

    // The root is prepended rather than relying on a zero lower bound, because
    // CognoDB's shortestPath omits the zero-length path. Without this the
    // package's OWN licence - the one most likely to matter - is missing from
    // its own licence report.
    OPTIONAL MATCH path = shortestPath((root)-[:DEPENDS_ON*1..8]->(other:Version))
    WITH root, collect({ node: other, depth: length(path) }) AS others

    UNWIND ([{ node: root, depth: 0 }] + others) AS entry
    WITH entry.node AS dependency, entry.depth AS depth
    WHERE dependency IS NOT NULL

    MATCH (dependency)-[:LICENSED_UNDER]->(license:License)

    WITH license,
         collect(DISTINCT dependency.packageName) AS packages,
         min(depth)                               AS shallowestDepth

    RETURN license.spdxId      AS spdxId,
           license.category    AS category,
           license.osiApproved AS osiApproved,
           size(packages)      AS packageCount,
           shallowestDepth,
           packages[..8]       AS examples
    ORDER BY
      // Most-restrictive obligations first - that is the order a reviewer cares about.
      CASE license.category
        WHEN 'network-copyleft' THEN 0
        WHEN 'strong-copyleft'  THEN 1
        WHEN 'weak-copyleft'    THEN 2
        WHEN 'proprietary'      THEN 3
        WHEN 'unknown'          THEN 4
        ELSE 5
      END,
      packageCount DESC
  `,
});

export interface LicenseExposure {
  spdxId: string;
  category: LicenseCategory;
  osiApproved: boolean;
  packageCount: number;
  shallowestDepth: number;
  examples: string[];
}

export async function getLicenseExposure(
  rootKey: string,
): Promise<{ rows: LicenseExposure[]; meta: QueryMeta }> {
  return readRows({
    statement: LICENSE_EXPOSURE.cypher,
    params: { rootKey },
    label: LICENSE_EXPOSURE.id,
    map: (record) => ({
      spdxId: record.get("spdxId") as string,
      category: record.get("category") as LicenseCategory,
      osiApproved: record.get("osiApproved") as boolean,
      packageCount: intToNumber(record.get("packageCount")),
      shallowestDepth: intToNumber(record.get("shallowestDepth")),
      examples: record.get("examples") as string[],
    }),
  });
}

/* -------------------------------------------------------------------------- */
/* 3. Duplicate versions                                                       */
/* -------------------------------------------------------------------------- */

export const DUPLICATE_VERSIONS = defineQuery({
  id: "duplicate-versions",
  group: "Dependency tree",
  title: "Packages installed at more than one version at once",
  question: "Am I shipping the same library three times because nothing agrees on a version?",
  whyGraph:
    "This is the payoff for modelling resolved versions as nodes instead of storing " +
    "declared ranges. Because every edge points at a concrete version, finding a " +
    "package that appears twice in one tree is a grouping over the traversal result. " +
    "A schema that stored ranges could not answer it at all without re-running " +
    "resolution at query time.",
  traversal: "0-8 hops, grouped by package name",
  parameters: [
    { name: "rootKey", description: "Version key to audit from", example: "express@4.17.1" },
  ],
  cypher: cypher`
    MATCH (root:Version { key: $rootKey })
    MATCH (root)-[:DEPENDS_ON*0..8]->(dependency:Version)
    WITH DISTINCT dependency

    WITH dependency.packageName            AS packageName,
         collect(DISTINCT dependency.version) AS versions
    WHERE size(versions) > 1

    RETURN packageName,
           versions,
           size(versions) AS versionCount
    ORDER BY versionCount DESC, packageName
  `,
});

export interface DuplicateVersion {
  packageName: string;
  versions: string[];
  versionCount: number;
}

export async function getDuplicateVersions(
  rootKey: string,
): Promise<{ rows: DuplicateVersion[]; meta: QueryMeta }> {
  return readRows({
    statement: DUPLICATE_VERSIONS.cypher,
    params: { rootKey },
    label: DUPLICATE_VERSIONS.id,
    map: (record) => ({
      packageName: record.get("packageName") as string,
      versions: record.get("versions") as string[],
      versionCount: intToNumber(record.get("versionCount")),
    }),
  });
}

/* -------------------------------------------------------------------------- */
/* 4. Single-maintainer packages                                               */
/* -------------------------------------------------------------------------- */

export const BUS_FACTOR = defineQuery({
  id: "bus-factor",
  group: "Supply-chain trust",
  title: "Dependencies with exactly one maintainer",
  question: "How much of what I install rests on a single person?",
  whyGraph:
    "Same traversal as the blast-radius query, aggregated from the other direction - " +
    "packages with a maintainer count of one, anywhere in the closure.",
  traversal: "0-8 hops down, then out to maintainers, filtered on degree",
  parameters: [
    { name: "rootKey", description: "Version key to audit from", example: "express@4.17.1" },
    { name: "limit", description: "Maximum rows", example: "20" },
  ],
  cypher: cypher`
    MATCH (root:Version { key: $rootKey })
    MATCH (root)-[:DEPENDS_ON*0..8]->(reachable:Version)
    WITH DISTINCT reachable

    MATCH (reachable)-[:VERSION_OF]->(pkg:Package)
    OPTIONAL MATCH (pkg)<-[:MAINTAINS]-(person:Maintainer)
    WITH pkg, collect(DISTINCT person.username) AS owners
    WHERE size(owners) = 1

    RETURN pkg.name              AS packageName,
           owners[0]             AS maintainer,
           pkg.weeklyDownloads   AS weeklyDownloads
    ORDER BY coalesce(pkg.weeklyDownloads, 0) DESC, pkg.name
    LIMIT $limit
  `,
});

export interface BusFactorRow {
  packageName: string;
  maintainer: string;
  weeklyDownloads: number | null;
}

export async function getBusFactor(
  rootKey: string,
  limit = 20,
): Promise<{ rows: BusFactorRow[]; meta: QueryMeta }> {
  return readRows({
    statement: BUS_FACTOR.cypher,
    params: { rootKey, limit: int(limit) },
    label: BUS_FACTOR.id,
    map: (record) => ({
      packageName: record.get("packageName") as string,
      maintainer: record.get("maintainer") as string,
      weeklyDownloads: (() => {
        const value = record.get("weeklyDownloads") as unknown;
        return value === null ? null : intToNumber(value as never);
      })(),
    }),
  });
}
