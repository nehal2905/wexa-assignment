import type { Cypher } from "@/lib/db/cypher";

/**
 * A query, its Cypher, and the explanation of why it is written that way.
 *
 * ## Why metadata sits next to the statement
 *
 * The application ships a `/queries` page that shows the Cypher behind every
 * view. That page reads *this* registry — the same objects the API executes — so
 * it is structurally impossible for the documentation to describe a query the
 * app no longer runs. Documentation that can drift from the code eventually
 * does; documentation generated from the code cannot.
 *
 * It also gives the query layer one honest place to record the trade-offs: which
 * traversals are bounded and why, which ones a relational schema would find
 * painful, and where a depth is hard-coded because Cypher will not accept it as
 * a parameter.
 */
export interface QueryParameter {
  name: string;
  description: string;
  example: string;
}

export interface QueryDefinition {
  /** Stable slug, used as an anchor on the /queries page. */
  id: string;
  title: string;
  /** The question in plain English, as a non-technical user would ask it. */
  question: string;
  /**
   * Why this is a graph query rather than a join. `null` for the handful of
   * lookups that a relational schema would handle perfectly well — claiming
   * otherwise would be dishonest.
   */
  whyGraph: string | null;
  /** Human description of traversal depth, e.g. "1–8 hops (variable length)". */
  traversal: string;
  parameters: QueryParameter[];
  cypher: Cypher;
  /** Grouping on the /queries page. */
  group: QueryGroup;
}

export type QueryGroup =
  | "Discovery"
  | "Dependency tree"
  | "Vulnerability reachability"
  | "Supply-chain trust"
  | "Licensing"
  | "Comparison";

/**
 * Identity function that exists purely to get inference and completeness
 * checking on every definition without repeating the type annotation.
 */
export function defineQuery(definition: QueryDefinition): QueryDefinition {
  return definition;
}

/**
 * Traversal depth is capped at eight hops throughout.
 *
 * Two reasons, one practical and one honest:
 *
 *  - Cypher does not accept a parameter as a variable-length bound
 *    (`*1..$depth` is a syntax error), so the bound must be a literal in the
 *    statement text. Since we refuse to build Cypher by concatenation, the
 *    depth is a constant here and any alternative depth is a separate, static
 *    statement.
 *  - Eight hops is past the point of usefulness for this dataset: the deepest
 *    real path in the seeded graph is six, and an unbounded traversal on a
 *    graph with dependency cycles is how you take a 256 MB instance offline.
 */
export const MAX_TRAVERSAL_DEPTH = 8;
