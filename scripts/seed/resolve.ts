import semver from "semver";

import { createLimiter } from "./http";
import { getPackageSnapshot, type PackageSnapshot } from "./registry";
import { ROOT_PACKAGES, type RootPackage } from "./roots";
import {
  categoriseLicense,
  isOsiApproved,
  versionKey,
  type DependencyScope,
  type LicenseCategory,
} from "@/lib/graph/model";

/**
 * The crawler: walks the dependency tree from each root, resolving every
 * declared semver range to the concrete version npm would actually install.
 *
 * ## The resolution rule
 *
 * `maxSatisfying` picks the highest published version inside the range, which is
 * what a fresh `npm install` with no lockfile produces. That is the honest
 * default for "what would I get today". It is not what a *locked* project gets —
 * a real audit tool would read package-lock.json — and the README says so
 * explicitly rather than pretending otherwise.
 *
 * ## Scope handling, matching npm's real behaviour
 *
 *  - `dependencies` are followed at every depth. They ship.
 *  - `devDependencies` are followed **only from a root**, because npm installs a
 *    package's devDependencies only when that package *is* the project. A
 *    transitive dependency's devDependencies never reach your disk.
 *  - `optionalDependencies` are followed like production ones; they usually
 *    install.
 *  - `peerDependencies` are recorded as a count but not traversed. Peer ranges
 *    are intentionally wide (`>=16`), and following them pulls in whole
 *    framework trees that the consumer may already have deduplicated — the
 *    resulting edges would suggest a certainty the data does not support.
 */

/* -------------------------------------------------------------------------- */
/* Output shapes                                                               */
/* -------------------------------------------------------------------------- */

export interface PackageRecord {
  name: string;
  nameLower: string;
  description: string | null;
  repository: string | null;
  homepage: string | null;
  latestVersion: string | null;
  weeklyDownloads: number | null;
  isRoot: boolean;
  /**
   * For roots: the version the crawl actually started from.
   *
   * A package can appear in the graph at several versions at once — that is the
   * whole point of resolving ranges — so "the root version of express" is not
   * recoverable by picking its newest `:Version` node. Recording it explicitly
   * is what lets the UI open the right starting point.
   */
  rootVersion: string | null;
  /** Populated for roots only; surfaced as a caveat in the UI. */
  rootBlurb: string | null;
  rootCategory: string | null;
  pinnedBecause: string | null;
}

export interface VersionRecord {
  key: string;
  packageName: string;
  version: string;
  publishedAt: string | null;
  deprecated: string | null;
  unpackedSize: number | null;
  fileCount: number | null;
  /** Count of declared peer dependencies — recorded, but not traversed. */
  peerDependencyCount: number;
}

export interface DependsOnRecord {
  fromKey: string;
  toKey: string;
  range: string;
  scope: DependencyScope;
}

export interface LicenseRecord {
  spdxId: string;
  category: LicenseCategory;
  osiApproved: boolean;
}

export interface MaintainerRecord {
  username: string;
  email: string | null;
}

export interface CrawlResult {
  packages: Map<string, PackageRecord>;
  versions: Map<string, VersionRecord>;
  dependsOn: DependsOnRecord[];
  licenses: Map<string, LicenseRecord>;
  /** versionKey → SPDX id */
  licensedUnder: Array<{ versionKey: string; spdxId: string }>;
  maintainers: Map<string, MaintainerRecord>;
  /** username → package name */
  maintains: Array<{ username: string; packageName: string }>;
  /** versionKey → username of whoever pushed that release */
  publishedBy: Array<{ versionKey: string; username: string }>;
  stats: CrawlStats;
}

export interface CrawlStats {
  packagesFetched: number;
  versionsResolved: number;
  edgesCreated: number;
  /** Ranges that no published version satisfied. */
  unsatisfiableRanges: number;
  /** Dependencies pointing at packages that no longer exist in the registry. */
  missingPackages: number;
  /** Non-registry specifiers (git URLs, `file:`, `workspace:`) we cannot resolve. */
  nonRegistrySpecifiers: number;
  /** Edges dropped because the package budget was exhausted. */
  truncatedAtBudget: number;
  maxDepthReached: number;
}

export interface CrawlOptions {
  maxDepth: number;
  maxPackages: number;
  concurrency: number;
  roots?: readonly RootPackage[];
  onProgress?: (message: string) => void;
}

/* -------------------------------------------------------------------------- */
/* Range resolution                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Specifiers npm understands that do not name a registry version. These are
 * legitimate in real package.json files but have no place in a version graph:
 * there is no published artefact to point an edge at.
 */
const NON_REGISTRY_PREFIX = /^(git\+|git:|github:|file:|link:|workspace:|npm:|https?:)/i;

function isNonRegistrySpecifier(range: string): boolean {
  return NON_REGISTRY_PREFIX.test(range.trim()) || range.includes("/");
}

/**
 * Resolves a range against a package's published versions.
 *
 * Falls back to `latest` for dist-tags (`"next"`, `"beta"`) and for `"*"`/`""`,
 * which `semver.maxSatisfying` cannot interpret on its own.
 */
function resolveRange(snapshot: PackageSnapshot, range: string): string | null {
  const trimmed = range.trim();

  if (trimmed === "" || trimmed === "*" || trimmed === "latest" || trimmed === "x") {
    return snapshot.latestVersion ?? semver.maxSatisfying(snapshot.versionList, "*", { loose: true });
  }

  if (semver.validRange(trimmed, { loose: true }) === null) {
    // Probably a dist-tag. The registry's own tag map is not in our reduced
    // snapshot, so `latest` is the honest approximation.
    return snapshot.latestVersion;
  }

  const match = semver.maxSatisfying(snapshot.versionList, trimmed, { loose: true });
  if (match !== null) return match;

  // Some ranges are only satisfiable by a prerelease (`^1.0.0-beta`). Retry
  // before declaring the range unsatisfiable.
  return semver.maxSatisfying(snapshot.versionList, trimmed, {
    loose: true,
    includePrerelease: true,
  });
}

/* -------------------------------------------------------------------------- */
/* Crawl                                                                       */
/* -------------------------------------------------------------------------- */

interface DependencyEdge {
  name: string;
  range: string;
  scope: DependencyScope;
}

function collectDependencies(
  snapshot: PackageSnapshot,
  version: string,
  includeDev: boolean,
): { edges: DependencyEdge[]; peerCount: number } {
  const entry = snapshot.versions[version];
  if (entry === undefined) return { edges: [], peerCount: 0 };

  const edges: DependencyEdge[] = [];

  for (const [name, range] of Object.entries(entry.dependencies)) {
    edges.push({ name, range, scope: "prod" });
  }
  for (const [name, range] of Object.entries(entry.optionalDependencies)) {
    // A package can list the same dependency as both required and optional;
    // the required declaration wins.
    if (!edges.some((edge) => edge.name === name)) {
      edges.push({ name, range, scope: "optional" });
    }
  }
  if (includeDev) {
    for (const [name, range] of Object.entries(entry.devDependencies)) {
      if (!edges.some((edge) => edge.name === name)) {
        edges.push({ name, range, scope: "dev" });
      }
    }
  }

  return { edges, peerCount: Object.keys(entry.peerDependencies).length };
}

export async function crawl(options: CrawlOptions): Promise<CrawlResult> {
  const { maxDepth, maxPackages, concurrency, roots = ROOT_PACKAGES, onProgress } = options;

  const limit = createLimiter(concurrency);

  const packages = new Map<string, PackageRecord>();
  const versions = new Map<string, VersionRecord>();
  const dependsOn: DependsOnRecord[] = [];
  const licenses = new Map<string, LicenseRecord>();
  const licensedUnder: Array<{ versionKey: string; spdxId: string }> = [];
  const maintainers = new Map<string, MaintainerRecord>();
  const maintains: Array<{ username: string; packageName: string }> = [];
  const publishedBy: Array<{ versionKey: string; username: string }> = [];

  const snapshots = new Map<string, PackageSnapshot | null>();
  /** `${name}|${range}` → versionKey, so an identical range is resolved once. */
  const resolutionCache = new Map<string, string | null>();
  const expanded = new Set<string>();

  const rootByName = new Map(roots.map((root) => [root.name, root]));

  const stats: CrawlStats = {
    packagesFetched: 0,
    versionsResolved: 0,
    edgesCreated: 0,
    unsatisfiableRanges: 0,
    missingPackages: 0,
    nonRegistrySpecifiers: 0,
    truncatedAtBudget: 0,
    maxDepthReached: 0,
  };

  async function loadSnapshot(name: string): Promise<PackageSnapshot | null> {
    const cached = snapshots.get(name);
    if (cached !== undefined) return cached;

    const snapshot = await getPackageSnapshot(name);
    snapshots.set(name, snapshot);
    if (snapshot === null) {
      stats.missingPackages += 1;
      return null;
    }
    stats.packagesFetched += 1;
    return snapshot;
  }

  /** Registers the :Package node, its maintainers, and the MAINTAINS edges. */
  function recordPackage(snapshot: PackageSnapshot): void {
    if (packages.has(snapshot.name)) return;

    const root = rootByName.get(snapshot.name);
    packages.set(snapshot.name, {
      name: snapshot.name,
      nameLower: snapshot.name.toLowerCase(),
      description: snapshot.description,
      repository: snapshot.repository,
      homepage: snapshot.homepage,
      latestVersion: snapshot.latestVersion,
      weeklyDownloads: null, // filled in later, in one bulk pass
      isRoot: root !== undefined,
      rootVersion: null, // set once the root's own range has been resolved
      rootBlurb: root?.blurb ?? null,
      rootCategory: root?.category ?? null,
      pinnedBecause: root?.pinnedBecause ?? null,
    });

    for (const maintainer of snapshot.maintainers) {
      if (!maintainers.has(maintainer.username)) {
        maintainers.set(maintainer.username, maintainer);
      }
      maintains.push({ username: maintainer.username, packageName: snapshot.name });
    }
  }

  /** Registers the :Version node plus its license and publisher edges. */
  function recordVersion(snapshot: PackageSnapshot, version: string): string {
    const key = versionKey(snapshot.name, version);
    if (versions.has(key)) return key;

    const entry = snapshot.versions[version];
    const { peerCount } = collectDependencies(snapshot, version, false);

    versions.set(key, {
      key,
      packageName: snapshot.name,
      version,
      publishedAt: entry?.publishedAt ?? null,
      deprecated: entry?.deprecated ?? null,
      unpackedSize: entry?.unpackedSize ?? null,
      fileCount: entry?.fileCount ?? null,
      peerDependencyCount: peerCount,
    });
    stats.versionsResolved += 1;

    const spdxId = entry?.license ?? "UNKNOWN";
    if (!licenses.has(spdxId)) {
      licenses.set(spdxId, {
        spdxId,
        category: categoriseLicense(spdxId),
        osiApproved: isOsiApproved(spdxId),
      });
    }
    licensedUnder.push({ versionKey: key, spdxId });

    if (entry?.publisher != null && entry.publisher !== "") {
      if (!maintainers.has(entry.publisher)) {
        maintainers.set(entry.publisher, { username: entry.publisher, email: null });
      }
      publishedBy.push({ versionKey: key, username: entry.publisher });
    }

    return key;
  }

  /**
   * Resolves `name@range` to a concrete version key, registering the package and
   * version records on the way. Memoised — the same range appears hundreds of
   * times across a large tree.
   */
  async function resolve(name: string, range: string): Promise<string | null> {
    const cacheKey = `${name}|${range}`;
    const cached = resolutionCache.get(cacheKey);
    if (cached !== undefined) return cached;

    if (isNonRegistrySpecifier(range)) {
      stats.nonRegistrySpecifiers += 1;
      resolutionCache.set(cacheKey, null);
      return null;
    }

    // Enforce the package budget only for names we have not seen. Resolving a
    // second range of an already-known package costs nothing extra.
    if (!snapshots.has(name) && packages.size >= maxPackages) {
      stats.truncatedAtBudget += 1;
      resolutionCache.set(cacheKey, null);
      return null;
    }

    const snapshot = await loadSnapshot(name);
    if (snapshot === null) {
      resolutionCache.set(cacheKey, null);
      return null;
    }

    const version = resolveRange(snapshot, range);
    if (version === null) {
      stats.unsatisfiableRanges += 1;
      resolutionCache.set(cacheKey, null);
      return null;
    }

    recordPackage(snapshot);
    const key = recordVersion(snapshot, version);
    resolutionCache.set(cacheKey, key);
    return key;
  }

  /* --- Breadth-first expansion, one depth level at a time ----------------- */

  onProgress?.(`Resolving ${roots.length} root packages…`);

  let frontier: string[] = [];
  const rootKeys = await Promise.all(
    roots.map((root) => limit(() => resolve(root.name, root.version ?? "latest"))),
  );
  for (const key of rootKeys) {
    if (key === null) continue;
    frontier.push(key);

    // Record which version the crawl started from, so the UI can open a root at
    // exactly the version that was audited rather than guessing.
    const resolved = versions.get(key);
    const record = resolved === undefined ? undefined : packages.get(resolved.packageName);
    if (resolved !== undefined && record !== undefined) {
      record.rootVersion = resolved.version;
    }
  }

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
    stats.maxDepthReached = depth;
    onProgress?.(
      `Depth ${depth}: expanding ${frontier.length} versions ` +
        `(${packages.size} packages, ${dependsOn.length} edges so far)…`,
    );

    const nextFrontier = new Set<string>();

    await Promise.all(
      frontier.map((parentKey) =>
        limit(async () => {
          if (expanded.has(parentKey)) return;
          expanded.add(parentKey);

          const record = versions.get(parentKey);
          if (record === undefined) return;

          const snapshot = snapshots.get(record.packageName);
          if (snapshot === undefined || snapshot === null) return;

          const { edges } = collectDependencies(
            snapshot,
            record.version,
            // devDependencies only from a root — see the note at the top.
            depth === 0 && rootByName.has(record.packageName),
          );

          for (const edge of edges) {
            const childKey = await resolve(edge.name, edge.range);
            if (childKey === null) continue;
            // Self-edges are meaningless and would create a 1-cycle that every
            // variable-length traversal then has to defend against.
            if (childKey === parentKey) continue;

            dependsOn.push({
              fromKey: parentKey,
              toKey: childKey,
              range: edge.range,
              scope: edge.scope,
            });
            stats.edgesCreated += 1;

            if (!expanded.has(childKey)) nextFrontier.add(childKey);
          }
        }),
      ),
    );

    frontier = [...nextFrontier];
  }

  onProgress?.(
    `Crawl complete: ${packages.size} packages, ${versions.size} versions, ${dependsOn.length} edges.`,
  );

  return {
    packages,
    versions,
    dependsOn,
    licenses,
    licensedUnder,
    maintainers,
    maintains,
    publishedBy,
    stats,
  };
}
