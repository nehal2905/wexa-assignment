import type { QueryDefinition, QueryGroup } from "./define";

import {
  GRAPH_STATISTICS,
  LIST_ROOT_PACKAGES,
  PACKAGE_VERSIONS,
  SEARCH_PACKAGES,
} from "./discovery";
import { UPGRADE_CHOKEPOINTS, VULNERABILITY_PATHS } from "./risk";
import {
  BUS_FACTOR,
  DUPLICATE_VERSIONS,
  LICENSE_EXPOSURE,
  MAINTAINER_BLAST_RADIUS,
} from "./supplychain";
import {
  DEPENDENCY_GRAPH_EDGES,
  DEPENDENCY_GRAPH_NODES,
  PACKAGE_OVERVIEW,
} from "./tree";
import { COMPARE_FOOTPRINTS, CONNECTION_PATH, DEPENDENTS } from "./compare";

/**
 * Every query the application runs, in one list.
 *
 * The `/queries` page renders this array directly, so what a reader sees there
 * is the same object the API executes - not a copy that has to be kept in sync.
 * Adding a query without registering it here is the only way to get them out of
 * step, and `verify-queries.ts` catches that by running the whole catalog.
 */
export const QUERY_CATALOG: readonly QueryDefinition[] = [
  // Discovery
  SEARCH_PACKAGES,
  LIST_ROOT_PACKAGES,
  PACKAGE_VERSIONS,
  GRAPH_STATISTICS,

  // Dependency tree
  PACKAGE_OVERVIEW,
  DEPENDENCY_GRAPH_NODES,
  DEPENDENCY_GRAPH_EDGES,
  DUPLICATE_VERSIONS,

  // Vulnerability reachability
  VULNERABILITY_PATHS,
  UPGRADE_CHOKEPOINTS,

  // Supply-chain trust
  MAINTAINER_BLAST_RADIUS,
  BUS_FACTOR,

  // Licensing
  LICENSE_EXPOSURE,

  // Comparison
  COMPARE_FOOTPRINTS,
  CONNECTION_PATH,
  DEPENDENTS,
];

export const QUERY_GROUPS: readonly QueryGroup[] = [
  "Discovery",
  "Dependency tree",
  "Vulnerability reachability",
  "Supply-chain trust",
  "Licensing",
  "Comparison",
];

export function queriesInGroup(group: QueryGroup): QueryDefinition[] {
  return QUERY_CATALOG.filter((query) => query.group === group);
}

export function findQuery(id: string): QueryDefinition | undefined {
  return QUERY_CATALOG.find((query) => query.id === id);
}

/**
 * How many catalog entries make a claim about being graph-native. Shown on the
 * `/queries` page so the count is derived rather than asserted in prose.
 */
export function graphNativeCount(): number {
  return QUERY_CATALOG.filter((query) => query.whyGraph !== null).length;
}

export type { QueryDefinition, QueryGroup } from "./define";
