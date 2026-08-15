import { closeDriver, readRows } from "@/lib/db/driver";
import { COUNT_NODES_BY_LABEL, COUNT_RELATIONSHIPS_BY_TYPE } from "@/lib/db/schema";
import { formatNumber, heading, reportFatal, table } from "./cli";

/**
 * Prints what is actually in the graph.
 *
 *   npm run db:stats
 *
 * Useful after a seed, and the quickest way to confirm a deployed instance is
 * pointing at populated data.
 */
async function main(): Promise<void> {
  const nodes = await readRows({
    statement: COUNT_NODES_BY_LABEL,
    params: {},
    label: "count-nodes",
    map: (record) => ({
      label: record.get("label") as string,
      count: (record.get("count") as { toNumber(): number }).toNumber(),
    }),
  });

  const relationships = await readRows({
    statement: COUNT_RELATIONSHIPS_BY_TYPE,
    params: {},
    label: "count-relationships",
    map: (record) => ({
      type: record.get("type") as string,
      count: (record.get("count") as { toNumber(): number }).toNumber(),
    }),
  });

  heading("Nodes");
  table(nodes.rows.map((row) => [row.label, formatNumber(row.count)] as const));
  table([["TOTAL", formatNumber(nodes.rows.reduce((sum, row) => sum + row.count, 0))]]);

  heading("Relationships");
  table(relationships.rows.map((row) => [row.type, formatNumber(row.count)] as const));
  table([["TOTAL", formatNumber(relationships.rows.reduce((sum, row) => sum + row.count, 0))]]);

  process.stdout.write("\n");
}

main()
  .catch((error: unknown) => reportFatal("Could not read graph statistics", error))
  .finally(() => closeDriver());
