import { cypher, int, type Cypher, type ParamValue } from "@/lib/db/cypher";
import { writeRows } from "@/lib/db/driver";

/**
 * Writes the crawled dataset into the graph.
 *
 * ## Why every statement is `UNWIND $rows AS row`
 *
 * The naive loader issues one query per node. For this dataset that is roughly
 * 25,000 round trips; against a cloud instance at ~40 ms each, about seventeen
 * minutes of pure latency. Batching with `UNWIND` sends 500 rows in a single
 * statement, turning the same load into a couple of hundred round trips and
 * about half a minute — and it is still fully parameterised, because `$rows` is
 * one parameter that happens to be a list.
 *
 * ## Why `MERGE` and not `CREATE`
 *
 * Every `MERGE` key below is backed by a uniqueness constraint (see
 * `src/lib/db/schema.ts`). That makes the load idempotent: running the seed
 * twice produces the same graph rather than a doubled one, which matters because
 * re-seeding is the normal way to pick up fresh advisory data.
 *
 * Batch size is deliberately conservative. The free (c0) tier has 256 MB of RAM,
 * and transaction state lives in heap — a 10,000-row batch will fail there while
 * working fine on a laptop.
 */

const BATCH_SIZE = 500;

export interface LoadProgress {
  step: string;
  done: number;
  total: number;
}

/**
 * Fields that must be stored as Bolt INTEGER rather than FLOAT.
 *
 * The driver sends every plain JavaScript number as a FLOAT because JS cannot
 * distinguish the two (see `int()` in `db/cypher.ts`). Left alone, a download
 * count of 12,340,000 is stored as `1.234e7`: it displays with a decimal point,
 * it compares differently in `ORDER BY`, and `intToNumber` has to guess on the
 * way back out. These are counts and byte sizes — they are integers, and the
 * database should know that.
 *
 * `cvssScore` is deliberately absent: 7.5 is genuinely fractional.
 */
const INTEGER_FIELDS = new Set([
  "weeklyDownloads",
  "unpackedSize",
  "fileCount",
  "peerDependencyCount",
  "prodDependencyCount",
  "prodVulnerabilityCount",
  "prodSevereCount",
]);

/**
 * Rewrites integral fields as Bolt integers, leaving everything else untouched.
 * Applied to every row on the way into a batch, so no call site has to remember.
 */
function coerceIntegerFields<T extends object>(row: T): Record<string, unknown> {
  // Spreading an `object`-constrained generic loses the index signature, so the
  // copy is built explicitly. `Object.entries` is safe here: every row is a
  // plain record produced by the crawler, never a class instance.
  const out: Record<string, unknown> = Object.fromEntries(Object.entries(row));
  for (const field of INTEGER_FIELDS) {
    const value = out[field];
    if (typeof value === "number" && Number.isInteger(value)) {
      out[field] = int(value);
    }
  }
  return out;
}

/**
 * Runs one statement over `rows` in batches.
 *
 * The cast on `$rows` is the one unavoidable seam between our typed records and
 * the driver's structural parameter type: a TypeScript `interface` has no
 * implicit index signature, so `PackageRecord[]` is not assignable to
 * `ParamValue[]` even though every field is a legal Bolt value. The cast is
 * local to this function rather than sprinkled across every call site.
 */
async function loadBatched<T extends object>(
  step: string,
  statement: Cypher,
  rows: readonly T[],
  onProgress?: (progress: LoadProgress) => void,
): Promise<{ nodesCreated: number; relationshipsCreated: number }> {
  let nodesCreated = 0;
  let relationshipsCreated = 0;

  if (rows.length === 0) {
    onProgress?.({ step, done: 0, total: 0 });
    return { nodesCreated, relationshipsCreated };
  }

  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    const batch = rows.slice(offset, offset + BATCH_SIZE).map(coerceIntegerFields);
    const outcome = await writeRows({
      statement,
      params: { rows: batch as unknown as ParamValue[] },
      label: step,
    });
    nodesCreated += outcome.nodesCreated;
    relationshipsCreated += outcome.relationshipsCreated;
    onProgress?.({ step, done: Math.min(offset + BATCH_SIZE, rows.length), total: rows.length });
  }

  return { nodesCreated, relationshipsCreated };
}

/* -------------------------------------------------------------------------- */
/* Statements                                                                  */
/* -------------------------------------------------------------------------- */

const UPSERT_PACKAGES: Cypher = cypher`
  UNWIND $rows AS row
  MERGE (p:Package { name: row.name })
  SET p.nameLower      = row.nameLower,
      p.description    = row.description,
      p.repository     = row.repository,
      p.homepage       = row.homepage,
      p.latestVersion  = row.latestVersion,
      p.weeklyDownloads= row.weeklyDownloads,
      p.isRoot         = row.isRoot,
      p.rootVersion    = row.rootVersion,
      p.prodDependencyCount    = row.prodDependencyCount,
      p.prodVulnerabilityCount = row.prodVulnerabilityCount,
      p.prodSevereCount        = row.prodSevereCount,
      p.rootBlurb      = row.rootBlurb,
      p.rootCategory   = row.rootCategory,
      p.pinnedBecause  = row.pinnedBecause
`;

const UPSERT_VERSIONS: Cypher = cypher`
  UNWIND $rows AS row
  MERGE (v:Version { key: row.key })
  SET v.packageName        = row.packageName,
      v.version            = row.version,
      v.publishedAt        = row.publishedAt,
      v.deprecated         = row.deprecated,
      v.unpackedSize       = row.unpackedSize,
      v.fileCount          = row.fileCount,
      v.peerDependencyCount= row.peerDependencyCount
  WITH v, row
  MATCH (p:Package { name: row.packageName })
  MERGE (v)-[:VERSION_OF]->(p)
`;

const UPSERT_DEPENDS_ON: Cypher = cypher`
  UNWIND $rows AS row
  MATCH (from:Version { key: row.fromKey })
  MATCH (to:Version   { key: row.toKey })
  MERGE (from)-[d:DEPENDS_ON]->(to)
  SET d.range = row.range,
      d.scope = row.scope
`;

const UPSERT_LICENSES: Cypher = cypher`
  UNWIND $rows AS row
  MERGE (l:License { spdxId: row.spdxId })
  SET l.category    = row.category,
      l.osiApproved = row.osiApproved
`;

const UPSERT_LICENSED_UNDER: Cypher = cypher`
  UNWIND $rows AS row
  MATCH (v:Version { key: row.versionKey })
  MATCH (l:License { spdxId: row.spdxId })
  MERGE (v)-[:LICENSED_UNDER]->(l)
`;

const UPSERT_MAINTAINERS: Cypher = cypher`
  UNWIND $rows AS row
  MERGE (m:Maintainer { username: row.username })
  SET m.email = coalesce(row.email, m.email)
`;

const UPSERT_MAINTAINS: Cypher = cypher`
  UNWIND $rows AS row
  MATCH (m:Maintainer { username: row.username })
  MATCH (p:Package    { name: row.packageName })
  MERGE (m)-[:MAINTAINS]->(p)
`;

const UPSERT_PUBLISHED_BY: Cypher = cypher`
  UNWIND $rows AS row
  MATCH (v:Version    { key: row.versionKey })
  MATCH (m:Maintainer { username: row.username })
  MERGE (v)-[:PUBLISHED_BY]->(m)
`;

const UPSERT_VULNERABILITIES: Cypher = cypher`
  UNWIND $rows AS row
  MERGE (v:Vulnerability { id: row.id })
  SET v.aliases   = row.aliases,
      v.severity  = row.severity,
      v.cvssScore = row.cvssScore,
      v.summary   = row.summary,
      v.details   = row.details,
      v.url       = row.url,
      v.published = row.published,
      v.cwes      = row.cwes
`;

const UPSERT_AFFECTS: Cypher = cypher`
  UNWIND $rows AS row
  MATCH (vuln:Vulnerability { id: row.vulnerabilityId })
  MATCH (ver:Version        { key: row.versionKey })
  MERGE (vuln)-[a:AFFECTS]->(ver)
  SET a.introducedIn = row.introducedIn,
      a.fixedIn      = row.fixedIn
`;

/* -------------------------------------------------------------------------- */
/* Orchestration                                                               */
/* -------------------------------------------------------------------------- */

export interface LoadPayload {
  packages: readonly object[];
  versions: readonly object[];
  dependsOn: readonly object[];
  licenses: readonly object[];
  licensedUnder: readonly object[];
  maintainers: readonly object[];
  maintains: readonly object[];
  publishedBy: readonly object[];
  vulnerabilities: readonly object[];
  affects: readonly object[];
}

export interface LoadSummary {
  nodesCreated: number;
  relationshipsCreated: number;
  elapsedMs: number;
}

/**
 * Load order is not arbitrary: every relationship statement `MATCH`es both of
 * its endpoints, so the nodes must already exist. Nodes first, then edges,
 * within each entity family.
 */
export async function loadGraph(
  payload: LoadPayload,
  onProgress?: (progress: LoadProgress) => void,
): Promise<LoadSummary> {
  const startedAt = Date.now();
  let nodesCreated = 0;
  let relationshipsCreated = 0;

  const steps: Array<[string, Cypher, readonly object[]]> = [
    ["packages", UPSERT_PACKAGES, payload.packages],
    ["licenses", UPSERT_LICENSES, payload.licenses],
    ["maintainers", UPSERT_MAINTAINERS, payload.maintainers],
    ["versions", UPSERT_VERSIONS, payload.versions],
    ["vulnerabilities", UPSERT_VULNERABILITIES, payload.vulnerabilities],
    ["dependency edges", UPSERT_DEPENDS_ON, payload.dependsOn],
    ["license edges", UPSERT_LICENSED_UNDER, payload.licensedUnder],
    ["maintainer edges", UPSERT_MAINTAINS, payload.maintains],
    ["publisher edges", UPSERT_PUBLISHED_BY, payload.publishedBy],
    ["advisory edges", UPSERT_AFFECTS, payload.affects],
  ];

  for (const [step, statement, rows] of steps) {
    const outcome = await loadBatched(step, statement, rows, onProgress);
    nodesCreated += outcome.nodesCreated;
    relationshipsCreated += outcome.relationshipsCreated;
  }

  return { nodesCreated, relationshipsCreated, elapsedMs: Date.now() - startedAt };
}
