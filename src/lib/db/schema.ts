import { cypher, type Cypher } from "./cypher";

/**
 * Schema definition: uniqueness constraints and supporting indexes.
 *
 * Two categories, treated differently:
 *
 *  - **Constraints are required.** Every one of them backs a `MERGE` key in the
 *    seed pipeline. Without them, a re-run of the seed would silently create
 *    duplicate `:Package` nodes instead of matching existing ones, and every
 *    traversal downstream would be wrong. If a constraint fails to apply, the
 *    schema step aborts.
 *
 *  - **Indexes are optimisations.** They make search and severity filtering fast,
 *    but the application is correct without them. Index *types* (TEXT, RANGE) are
 *    the most vendor-specific corner of openCypher, so a failure here is logged
 *    as a warning and the run continues. On a few-thousand-node graph the
 *    difference is imperceptible; on a larger one you would want them.
 *
 * Every statement uses `IF NOT EXISTS`, so applying the schema is idempotent and
 * safe to run before every seed.
 */

export interface SchemaStatement {
  name: string;
  /** What this enables, quoted in CLI output. */
  purpose: string;
  statement: Cypher;
  required: boolean;
}

export const CONSTRAINTS: readonly SchemaStatement[] = [
  {
    name: "package_name_unique",
    purpose: "one :Package node per registry name",
    required: true,
    statement: cypher`
      CREATE CONSTRAINT package_name_unique IF NOT EXISTS
      FOR (p:Package) REQUIRE p.name IS UNIQUE
    `,
  },
  {
    name: "version_key_unique",
    purpose: "one :Version node per name@version",
    required: true,
    statement: cypher`
      CREATE CONSTRAINT version_key_unique IF NOT EXISTS
      FOR (v:Version) REQUIRE v.key IS UNIQUE
    `,
  },
  {
    name: "maintainer_username_unique",
    purpose: "one :Maintainer node per npm account",
    required: true,
    statement: cypher`
      CREATE CONSTRAINT maintainer_username_unique IF NOT EXISTS
      FOR (m:Maintainer) REQUIRE m.username IS UNIQUE
    `,
  },
  {
    name: "vulnerability_id_unique",
    purpose: "one :Vulnerability node per OSV advisory",
    required: true,
    statement: cypher`
      CREATE CONSTRAINT vulnerability_id_unique IF NOT EXISTS
      FOR (v:Vulnerability) REQUIRE v.id IS UNIQUE
    `,
  },
  {
    name: "license_spdx_unique",
    purpose: "one :License node per SPDX identifier",
    required: true,
    statement: cypher`
      CREATE CONSTRAINT license_spdx_unique IF NOT EXISTS
      FOR (l:License) REQUIRE l.spdxId IS UNIQUE
    `,
  },
];

export const INDEXES: readonly SchemaStatement[] = [
  {
    name: "package_name_lower_text",
    purpose: "case-insensitive CONTAINS search in the package picker",
    required: false,
    statement: cypher`
      CREATE TEXT INDEX package_name_lower_text IF NOT EXISTS
      FOR (p:Package) ON (p.nameLower)
    `,
  },
  {
    name: "package_downloads_range",
    purpose: "ordering search results and the landing page by popularity",
    required: false,
    statement: cypher`
      CREATE INDEX package_downloads_range IF NOT EXISTS
      FOR (p:Package) ON (p.weeklyDownloads)
    `,
  },
  {
    name: "package_is_root",
    purpose: "listing the seeded root applications",
    required: false,
    statement: cypher`
      CREATE INDEX package_is_root IF NOT EXISTS
      FOR (p:Package) ON (p.isRoot)
    `,
  },
  {
    name: "version_package_name",
    purpose: "finding every stored version of a package without a hop",
    required: false,
    statement: cypher`
      CREATE INDEX version_package_name IF NOT EXISTS
      FOR (v:Version) ON (v.packageName)
    `,
  },
  {
    name: "vulnerability_severity",
    purpose: "filtering advisories by severity band",
    required: false,
    statement: cypher`
      CREATE INDEX vulnerability_severity IF NOT EXISTS
      FOR (v:Vulnerability) ON (v.severity)
    `,
  },
];

export const SCHEMA_STATEMENTS: readonly SchemaStatement[] = [...CONSTRAINTS, ...INDEXES];

/* -------------------------------------------------------------------------- */
/* Teardown                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Deletes all data in batches.
 *
 * `CALL { ... } IN TRANSACTIONS` keeps each batch in its own transaction so the
 * delete never has to hold the whole graph in memory at once — which matters a
 * great deal on a 256 MB free-tier instance, where a naive
 * `MATCH (n) DETACH DELETE n` will run the server out of heap.
 */
export const DELETE_ALL_BATCHED: Cypher = cypher`
  MATCH (n)
  CALL { WITH n DETACH DELETE n } IN TRANSACTIONS OF 500 ROWS
`;

/** Fallback for servers that do not support CALL { } IN TRANSACTIONS. */
export const DELETE_ALL_SIMPLE: Cypher = cypher`
  MATCH (n) DETACH DELETE n
`;

/* -------------------------------------------------------------------------- */
/* Introspection                                                               */
/* -------------------------------------------------------------------------- */

/** Node counts per label, used by `npm run db:stats` and the About page. */
export const COUNT_NODES_BY_LABEL: Cypher = cypher`
  MATCH (n)
  UNWIND labels(n) AS label
  RETURN label, count(*) AS count
  ORDER BY count DESC
`;

export const COUNT_RELATIONSHIPS_BY_TYPE: Cypher = cypher`
  MATCH ()-[r]->()
  RETURN type(r) AS type, count(*) AS count
  ORDER BY count DESC
`;
