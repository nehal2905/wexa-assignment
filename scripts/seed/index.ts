import {
  endProgress,
  formatDuration,
  formatNumber,
  heading,
  ok,
  progress,
  reportFatal,
  step,
  style,
  table,
  warn,
} from "../cli";
import { applySchema } from "../apply-schema";
import { crawl } from "./resolve";
import { fetchWeeklyDownloads } from "./registry";
import { fetchAdvisories, findVulnerabilityIds, windowForVersion } from "./osv";
import { loadGraph } from "./load";
import { closeDriver } from "@/lib/db/driver";
import { getEnv, loadEnvFiles } from "@/lib/env";
import { parseVersionKey } from "@/lib/graph/model";

/**
 * Seed pipeline entry point.
 *
 *   npm run db:seed
 *
 * Six phases, each independently observable:
 *
 *   1. schema     — constraints and indexes (idempotent)
 *   2. crawl      — walk the dependency tree, resolving every range
 *   3. downloads  — weekly download counts for weighting
 *   4. advisories — ask OSV which resolved versions are vulnerable
 *   5. details    — fetch each advisory
 *   6. load       — batched writes into the graph
 *
 * Phases 2–5 are cached to disk, so a re-run after a failed load takes seconds
 * rather than minutes.
 */

interface SeedConfig {
  maxDepth: number;
  maxPackages: number;
  concurrency: number;
  wipe: boolean;
}

function readConfig(): SeedConfig {
  loadEnvFiles();
  const readInt = (name: string, fallback: number): number => {
    const raw = process.env[name];
    const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  return {
    maxDepth: readInt("SEED_MAX_DEPTH", 5),
    maxPackages: readInt("SEED_MAX_PACKAGES", 1200),
    concurrency: readInt("SEED_CONCURRENCY", 8),
    wipe: process.argv.includes("--wipe"),
  };
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const config = readConfig();
  const env = getEnv();

  heading("Understory · seed");
  table([
    ["target", `${env.displayHost} (${env.neo4jDatabase})`],
    ["encrypted", env.isSecure ? "yes" : "no — local development"],
    ["max depth", config.maxDepth],
    ["package budget", formatNumber(config.maxPackages)],
    ["concurrency", config.concurrency],
  ]);

  /* --- 1. Schema --------------------------------------------------------- */

  heading("1 · Schema");
  await applySchema({ quiet: false });

  /* --- 2. Crawl ---------------------------------------------------------- */

  heading("2 · Crawling the dependency tree");
  const crawlResult = await crawl({
    maxDepth: config.maxDepth,
    maxPackages: config.maxPackages,
    concurrency: config.concurrency,
    onProgress: (message) => step(message),
  });

  const { stats } = crawlResult;
  ok(
    `${formatNumber(crawlResult.packages.size)} packages · ` +
      `${formatNumber(crawlResult.versions.size)} versions · ` +
      `${formatNumber(crawlResult.dependsOn.length)} dependency edges`,
  );

  if (stats.truncatedAtBudget > 0) {
    warn(
      `${formatNumber(stats.truncatedAtBudget)} edges dropped at the package budget. ` +
        `Raise SEED_MAX_PACKAGES for a wider graph.`,
    );
  }
  if (stats.unsatisfiableRanges > 0 || stats.missingPackages > 0 || stats.nonRegistrySpecifiers > 0) {
    step(
      style.dim(
        `skipped: ${stats.unsatisfiableRanges} unsatisfiable ranges, ` +
          `${stats.missingPackages} missing packages, ` +
          `${stats.nonRegistrySpecifiers} non-registry specifiers`,
      ),
    );
  }

  /* --- 3. Download counts ------------------------------------------------ */

  heading("3 · Weekly download counts");
  const packageNames = [...crawlResult.packages.keys()];
  const downloads = await fetchWeeklyDownloads(packageNames, config.concurrency);
  for (const [name, record] of crawlResult.packages) {
    record.weeklyDownloads = downloads.get(name) ?? null;
  }
  ok(`${formatNumber(downloads.size)} of ${formatNumber(packageNames.length)} packages have counts`);

  /* --- 4. Advisory matching ---------------------------------------------- */

  heading("4 · Matching versions against OSV advisories");
  const versionRefs = [...crawlResult.versions.values()].map((version) => ({
    name: version.packageName,
    version: version.version,
  }));

  const idsByVersion = await findVulnerabilityIds(
    versionRefs,
    config.concurrency,
    (done, total) => progress(`querying OSV… batch ${done}/${total}`),
  );
  endProgress();

  const uniqueIds = [...new Set([...idsByVersion.values()].flat())];
  ok(
    `${formatNumber(idsByVersion.size)} vulnerable versions referencing ` +
      `${formatNumber(uniqueIds.length)} distinct advisories`,
  );

  /* --- 5. Advisory detail ------------------------------------------------ */

  heading("5 · Fetching advisory detail");
  const advisories = await fetchAdvisories(uniqueIds, config.concurrency, (done, total) =>
    progress(`fetching advisories… ${done}/${total}`),
  );
  endProgress();
  ok(`${formatNumber(advisories.size)} advisories retrieved`);

  // Build the AFFECTS edges, attaching the specific version window that applies.
  const affects: Array<{
    vulnerabilityId: string;
    versionKey: string;
    introducedIn: string | null;
    fixedIn: string | null;
  }> = [];

  for (const [key, ids] of idsByVersion) {
    const parsed = parseVersionKey(key);
    if (parsed === null) continue;
    for (const id of ids) {
      const advisory = advisories.get(id);
      if (advisory === undefined) continue; // withdrawn between the two calls
      const window = windowForVersion(advisory, parsed.packageName, parsed.version);
      affects.push({
        vulnerabilityId: id,
        versionKey: key,
        introducedIn: window.introducedIn,
        fixedIn: window.fixedIn,
      });
    }
  }

  /* --- 6. Load ----------------------------------------------------------- */

  heading("6 · Loading into the graph");
  if (config.wipe) {
    warn("--wipe was passed; run `npm run db:reset` first if you want a clean graph.");
  }

  const summary = await loadGraph(
    {
      packages: [...crawlResult.packages.values()],
      versions: [...crawlResult.versions.values()],
      dependsOn: crawlResult.dependsOn,
      licenses: [...crawlResult.licenses.values()],
      licensedUnder: crawlResult.licensedUnder,
      maintainers: [...crawlResult.maintainers.values()],
      maintains: crawlResult.maintains,
      publishedBy: crawlResult.publishedBy,
      vulnerabilities: [...advisories.values()].map((advisory) => ({
        id: advisory.id,
        aliases: advisory.aliases,
        severity: advisory.severity,
        cvssScore: advisory.cvssScore,
        summary: advisory.summary,
        details: advisory.details,
        url: advisory.url,
        published: advisory.published,
        cwes: advisory.cwes,
      })),
      affects,
    },
    ({ step: name, done, total }) => progress(`${name}… ${formatNumber(done)}/${formatNumber(total)}`),
  );
  endProgress();

  heading("Done");
  table([
    ["nodes created", formatNumber(summary.nodesCreated)],
    ["relationships created", formatNumber(summary.relationshipsCreated)],
    ["load time", formatDuration(summary.elapsedMs)],
    ["total time", formatDuration(Date.now() - startedAt)],
  ]);
  process.stdout.write(
    `\n  ${style.dim("Next:")} npm run dev  ${style.dim("→")}  http://localhost:3000\n\n`,
  );
}

main()
  .catch((error: unknown) => reportFatal("Seed failed", error))
  .finally(() => closeDriver());
