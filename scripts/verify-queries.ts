import { closeDriver } from "@/lib/db/driver";
import { QUERY_CATALOG } from "@/lib/queries/catalog";
import {
  getGraphStatistics,
  listRootPackages,
  searchPackages,
} from "@/lib/queries/discovery";
import { getUpgradeChokepoints, getVulnerabilityPaths } from "@/lib/queries/risk";
import {
  getBusFactor,
  getDuplicateVersions,
  getLicenseExposure,
  getMaintainerBlastRadius,
} from "@/lib/queries/supplychain";
import { getDependencyGraph, getPackageOverview } from "@/lib/queries/tree";
import { compareFootprints, findConnectionPath, getDependents } from "@/lib/queries/compare";
import { fail, formatNumber, heading, ok, style, warn } from "./cli";

/**
 * Runs every query in the catalog against the live graph.
 *
 *   npx tsx scripts/verify-queries.ts
 *
 * This is the closest thing this project has to an integration test suite, and
 * it earns its place three times over:
 *
 *  - Cypher is not type-checked. A renamed property or a typo'd label compiles
 *    perfectly and fails at runtime, in production, on a page nobody opened
 *    during development. Running every statement once catches all of it.
 *  - It surfaces the server-side timing of each query, which is how the
 *    traversal depths and result limits in the catalog were chosen.
 *  - It fails if a query returns zero rows where rows are expected, which is the
 *    failure mode a smoke test would otherwise miss entirely — an empty table
 *    looks exactly like "no problems found".
 */

interface Check {
  name: string;
  run: () => Promise<{ rows: unknown[]; meta: { consumedAfterMs: number; roundTripMs: number } }>;
  /** Zero rows is a failure for these — the seeded data guarantees results. */
  expectRows: boolean;
}

const ROOT = "express@4.17.1";

const CHECKS: Check[] = [
  { name: "searchPackages('exp')", expectRows: true, run: () => searchPackages("exp", 10) },
  { name: "listRootPackages()", expectRows: true, run: () => listRootPackages() },
  { name: "getGraphStatistics()", expectRows: true, run: () => getGraphStatistics() },
  { name: `getPackageOverview('${ROOT}')`, expectRows: true, run: () => getPackageOverview(ROOT) },
  {
    name: `getDependencyGraph('${ROOT}', depth 3)`,
    expectRows: true,
    run: async () => {
      const result = await getDependencyGraph(ROOT, 3, 400);
      return { rows: [...result.nodes, ...result.edges], meta: result.meta };
    },
  },
  {
    name: `getVulnerabilityPaths('${ROOT}')`,
    expectRows: true,
    run: () => getVulnerabilityPaths(ROOT),
  },
  {
    name: `getUpgradeChokepoints('${ROOT}')`,
    expectRows: true,
    run: () => getUpgradeChokepoints(ROOT, 10),
  },
  {
    name: `getMaintainerBlastRadius('${ROOT}')`,
    expectRows: true,
    run: () => getMaintainerBlastRadius(ROOT, 15),
  },
  { name: `getBusFactor('${ROOT}')`, expectRows: true, run: () => getBusFactor(ROOT, 20) },
  {
    name: `getLicenseExposure('${ROOT}')`,
    expectRows: true,
    run: () => getLicenseExposure(ROOT),
  },
  {
    name: `getDuplicateVersions('${ROOT}')`,
    // A clean tree legitimately has no duplicates, so zero rows is a valid answer.
    expectRows: false,
    run: () => getDuplicateVersions(ROOT),
  },
  {
    name: "compareFootprints(express, koa)",
    expectRows: true,
    run: async () => {
      const roots = await listRootPackages();
      const koa = roots.rows.find((row) => row.name === "koa");
      const right = koa === undefined ? ROOT : `${koa.name}@${koa.version}`;
      return compareFootprints(ROOT, right);
    },
  },
  {
    name: "findConnectionPath(express → ms)",
    expectRows: false,
    run: () => findConnectionPath("express", "ms"),
  },
  { name: "getDependents('ms')", expectRows: false, run: () => getDependents("ms", 25) },
];

/**
 * Correctness invariants, as opposed to "did it run".
 *
 * The production-scoped reachability queries constrain the traversal with an
 * `ALL(...)` predicate inside `shortestPath`, relying on the planner evaluating
 * it during expansion rather than as a post-filter. That is a real assumption
 * about the query planner, and if it were wrong the failure would be silent —
 * the tool would simply under-report. So it is asserted here rather than
 * trusted.
 */
async function checkInvariants(): Promise<number> {
  let failures = 0;

  const all = await getVulnerabilityPaths(ROOT, undefined, "all");
  const production = await getVulnerabilityPaths(ROOT, undefined, "production");

  const leaked = production.rows.filter((row) => row.pathScopes.includes("dev"));
  if (leaked.length > 0) {
    failures += 1;
    fail(
      `production scope leaked ${leaked.length} dev path(s) — e.g. ${leaked[0]?.pathKeys.join(" -> ")}`,
    );
  } else {
    ok(
      `production scope excludes every dev edge ` +
        style.dim(`(${production.rows.length} production vs ${all.rows.length} total paths)`),
    );
  }

  if (production.rows.length > all.rows.length) {
    failures += 1;
    fail("production scope returned more paths than the unrestricted scope, which is impossible");
  }

  // Every path must start at the audited root and end at the vulnerable package.
  const misrooted = production.rows.filter(
    (row) => row.pathKeys[0] !== ROOT || row.pathKeys[row.pathKeys.length - 1] !== row.targetKey,
  );
  if (misrooted.length > 0) {
    failures += 1;
    fail(`${misrooted.length} path(s) do not run from the root to the reported target`);
  } else {
    ok("every returned path runs from the audited root to the reported vulnerable version");
  }

  // Reported depth must equal the number of hops in the returned path.
  const badDepth = production.rows.filter((row) => row.depth !== row.pathKeys.length - 1);
  if (badDepth.length > 0) {
    failures += 1;
    fail(`${badDepth.length} path(s) report a depth that disagrees with their path length`);
  } else {
    ok("reported depth matches path length on every row");
  }

  /**
   * The audited package must appear in its own graph.
   *
   * `shortestPath` with a zero lower bound returns the start node on Neo4j and
   * does NOT on CognoDB, so `*0..N` silently dropped the root everywhere it was
   * used. The visible symptom was a missing node on the canvas; the invisible
   * one was advisories and licence obligations on the package being audited
   * going unreported. Both are asserted here so the difference can never quietly
   * come back.
   */
  const graph = await getDependencyGraph(ROOT, 2, 400);
  const rootNode = graph.nodes.find((node) => node.key === ROOT);
  if (rootNode === undefined) {
    failures += 1;
    fail(`the audited package is missing from its own dependency graph (${ROOT})`);
  } else if (rootNode.depth !== 0) {
    failures += 1;
    fail(`the audited package is present but at depth ${rootNode.depth} rather than 0`);
  } else {
    ok("the audited package appears in its own graph at depth 0");
  }

  const licences = await getLicenseExposure(ROOT);
  const coversRoot = licences.rows.some((row) => row.shallowestDepth === 0);
  if (!coversRoot) {
    failures += 1;
    fail("licence exposure omits the audited package's own licence (depth 0)");
  } else {
    ok("licence exposure includes the audited package's own licence");
  }

  // An advisory affecting the root itself is reachable at depth 0 by definition.
  const selfAdvisories = production.rows.filter((row) => row.depth === 0);
  ok(
    `${selfAdvisories.length} advisor${selfAdvisories.length === 1 ? "y" : "ies"} on the audited package itself ` +
      style.dim("(these were dropped entirely before the zero-length-path fix)"),
  );

  return failures;
}

async function main(): Promise<void> {
  heading(`Understory · verifying ${CHECKS.length} query paths across ${QUERY_CATALOG.length} catalog entries`);

  let failures = 0;
  let slowest = { name: "", ms: 0 };

  for (const check of CHECKS) {
    try {
      const result = await check.run();
      const serverMs = result.meta.consumedAfterMs;
      const totalMs = result.meta.roundTripMs;

      if (totalMs > slowest.ms) slowest = { name: check.name, ms: totalMs };

      const timing = style.dim(`${serverMs} ms server · ${totalMs} ms round trip`);
      const count = `${formatNumber(result.rows.length)} row${result.rows.length === 1 ? "" : "s"}`;

      if (check.expectRows && result.rows.length === 0) {
        failures += 1;
        fail(`${check.name} — returned no rows, but rows were expected`);
        continue;
      }

      if (totalMs > 1500) {
        warn(`${check.name} — ${count}, ${timing}  ${style.yellow("(slow)")}`);
      } else {
        ok(`${check.name} — ${count}, ${timing}`);
      }
    } catch (error) {
      failures += 1;
      fail(`${check.name} — ${error instanceof Error ? error.message : String(error)}`);

      // The API deliberately hides driver detail from users (see db/errors.ts).
      // This is a developer tool, so unwrap the chain and show what actually broke.
      let cause: unknown = error instanceof Error ? error.cause : undefined;
      while (cause instanceof Error) {
        process.stderr.write(`      ${style.dim(cause.message.split("\n")[0] ?? "")}\n`);
        cause = cause.cause;
      }
    }
  }

  heading("Invariants");
  failures += await checkInvariants();

  process.stdout.write("\n");
  if (failures === 0) {
    ok(`All ${CHECKS.length} query paths executed successfully.`);
    process.stdout.write(`  ${style.dim(`slowest: ${slowest.name} at ${slowest.ms} ms`)}\n\n`);
  } else {
    fail(`${failures} of ${CHECKS.length} query paths failed.\n`);
    process.exitCode = 1;
  }
}

main()
  .catch((error: unknown) => {
    fail(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => closeDriver());
