import { createLimiter, fetchJson, HttpError, readCache, writeCache } from "./http";

/**
 * Client for the public npm registry.
 *
 * The registry returns a "packument" per package: every published version, with
 * full metadata, in one document. For popular packages that is several megabytes,
 * and we need only a small slice of it. So each packument is fetched once,
 * immediately reduced to the {@link PackageSnapshot} below, and the raw document
 * is discarded - only the reduction is cached. Holding 900 raw packuments in
 * memory would be gigabytes; holding 900 snapshots is a few tens of megabytes.
 */

const REGISTRY = "https://registry.npmjs.org";
const DOWNLOADS_API = "https://api.npmjs.org/downloads";

/* -------------------------------------------------------------------------- */
/* Raw registry shapes (only the fields we read)                               */
/* -------------------------------------------------------------------------- */

interface RawPerson {
  name?: string;
  email?: string;
}

interface RawDist {
  unpackedSize?: number;
  fileCount?: number;
}

/**
 * The registry is twenty years of accumulated publishing history, and its JSON
 * is not as typed as the interfaces below imply. `deprecated` is documented as a
 * string but is frequently the boolean `true`; `description` and `homepage` are
 * occasionally objects or arrays. Every free-text field therefore goes through
 * this guard rather than `?.trim()`, which throws on anything that is not a
 * string and would abort a seed run several hundred packages in.
 */
function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

interface RawVersion {
  version?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  license?: unknown;
  licenses?: unknown;
  /** Documented as a string; in practice often `true`. */
  deprecated?: unknown;
  dist?: RawDist;
  _npmUser?: RawPerson;
  maintainers?: RawPerson[];
}

interface RawPackument {
  name?: string;
  description?: unknown;
  homepage?: unknown;
  repository?: unknown;
  maintainers?: RawPerson[];
  "dist-tags"?: Record<string, string>;
  versions?: Record<string, RawVersion>;
  time?: Record<string, string>;
}

/* -------------------------------------------------------------------------- */
/* Reduced shapes we actually keep                                             */
/* -------------------------------------------------------------------------- */

export interface VersionSnapshot {
  version: string;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  /** Normalised SPDX identifier, or null when the package declares none. */
  license: string | null;
  deprecated: string | null;
  unpackedSize: number | null;
  fileCount: number | null;
  publishedAt: string | null;
  /** npm account that pushed this specific version. */
  publisher: string | null;
}

export interface PackageSnapshot {
  name: string;
  description: string | null;
  repository: string | null;
  homepage: string | null;
  latestVersion: string | null;
  maintainers: Array<{ username: string; email: string | null }>;
  /** Every published version string, needed for semver range resolution. */
  versionList: string[];
  versions: Record<string, VersionSnapshot>;
}

/* -------------------------------------------------------------------------- */
/* Normalisation                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The `license` field has accumulated four shapes over npm's history: a string,
 * an object with `.type`, an array of either, and the long-deprecated plural
 * `licenses` key. Older packages in a deep dependency tree genuinely still use
 * the old forms, so all of them are handled.
 */
function normaliseLicense(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;

  const direct = asString(raw);
  if (direct !== null) return direct;

  if (Array.isArray(raw)) {
    const parts = raw
      .map((entry) =>
        asString(entry) ?? asString((entry as { type?: unknown } | null)?.type),
      )
      .filter((entry): entry is string => entry !== null);
    if (parts.length === 0) return null;
    // `(MIT OR Apache-2.0)` is the SPDX way to express a choice of licenses.
    return parts.length === 1 ? parts[0]! : `(${parts.join(" OR ")})`;
  }

  if (typeof raw === "object") {
    return asString((raw as { type?: unknown }).type);
  }
  return null;
}

/** Turns the various repository shapes into a plain https URL where possible. */
function normaliseRepository(raw: unknown): string | null {
  const url =
    asString(raw) ??
    (typeof raw === "object" && raw !== null
      ? asString((raw as { url?: unknown }).url)
      : null);
  if (url === null) return null;
  return url
    .replace(/^git\+/, "")
    .replace(/^git:\/\//, "https://")
    .replace(/^ssh:\/\/git@/, "https://")
    .replace(/\.git$/, "")
    .trim();
}

function normalisePerson(person: RawPerson | undefined): {
  username: string;
  email: string | null;
} | null {
  const username = asString(person?.name);
  if (username === null) return null;
  return { username, email: asString(person?.email) };
}

/**
 * A dependency map must be an object of `name -> range` strings. Anything else
 * (a string, an array, `null`) is discarded - iterating a string with
 * `Object.entries` yields character indices, which would produce nonsense
 * package names rather than an error.
 */
function asDependencyMap(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [name, range] of Object.entries(value as Record<string, unknown>)) {
    if (typeof range === "string") out[name] = range;
  }
  return out;
}

function reducePackument(raw: RawPackument, name: string): PackageSnapshot {
  const rawVersions =
    typeof raw.versions === "object" && raw.versions !== null ? raw.versions : {};
  const time = typeof raw.time === "object" && raw.time !== null ? raw.time : {};

  const versions: Record<string, VersionSnapshot> = {};
  for (const [version, entry] of Object.entries(rawVersions)) {
    if (typeof entry !== "object" || entry === null) continue;
    versions[version] = {
      version,
      dependencies: asDependencyMap(entry.dependencies),
      devDependencies: asDependencyMap(entry.devDependencies),
      optionalDependencies: asDependencyMap(entry.optionalDependencies),
      peerDependencies: asDependencyMap(entry.peerDependencies),
      license: normaliseLicense(entry.license ?? entry.licenses),
      // `true` is a real value here, meaning "deprecated, no reason given".
      deprecated:
        entry.deprecated === true
          ? "This version is deprecated."
          : asString(entry.deprecated),
      unpackedSize: typeof entry.dist?.unpackedSize === "number" ? entry.dist.unpackedSize : null,
      fileCount: typeof entry.dist?.fileCount === "number" ? entry.dist.fileCount : null,
      publishedAt: asString((time as Record<string, unknown>)[version]),
      publisher: normalisePerson(entry._npmUser)?.username ?? null,
    };
  }

  const maintainers = (Array.isArray(raw.maintainers) ? raw.maintainers : [])
    .map(normalisePerson)
    .filter((entry): entry is { username: string; email: string | null } => entry !== null);

  return {
    name,
    description: asString(raw.description),
    repository: normaliseRepository(raw.repository),
    homepage: asString(raw.homepage),
    latestVersion: asString(raw["dist-tags"]?.latest),
    maintainers,
    versionList: Object.keys(versions),
    versions,
  };
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                  */
/* -------------------------------------------------------------------------- */

/** Registry paths need the `/` in scoped names percent-encoded. */
function encodePackageName(name: string): string {
  return name.startsWith("@") ? name.replace("/", "%2f") : name;
}

/**
 * Fetches and reduces a packument. Returns null for packages that do not exist
 * (unpublished, renamed, or typo'd in someone's package.json - all of which
 * occur in real dependency trees and none of which should abort a seed run).
 */
export async function getPackageSnapshot(name: string): Promise<PackageSnapshot | null> {
  const cached = readCache<PackageSnapshot | { missing: true }>("packument", name);
  if (cached !== null) {
    return "missing" in cached ? null : cached;
  }

  try {
    const raw = await fetchJson<RawPackument>(`${REGISTRY}/${encodePackageName(name)}`);
    const snapshot = reducePackument(raw, name);
    writeCache("packument", name, snapshot);
    return snapshot;
  } catch (error) {
    if (error instanceof HttpError && (error.status === 404 || error.status === 405)) {
      writeCache("packument", name, { missing: true });
      return null;
    }
    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/* Download counts                                                             */
/* -------------------------------------------------------------------------- */

interface BulkDownloadsResponse {
  [packageName: string]: { downloads?: number } | null;
}

interface SingleDownloadsResponse {
  downloads?: number;
}

/**
 * Weekly download counts, used to weight "how much does this dependency
 * actually matter" in the UI.
 *
 * The bulk endpoint accepts up to 128 names per call but rejects scoped
 * packages outright, so scoped names are fetched individually. Download data is
 * a nice-to-have: any failure yields `null` for that package rather than
 * failing the seed.
 */
export async function fetchWeeklyDownloads(
  names: readonly string[],
  concurrency: number,
): Promise<Map<string, number>> {
  const result = new Map<string, number>();
  const limit = createLimiter(concurrency);

  const scoped = names.filter((name) => name.startsWith("@"));
  const unscoped = names.filter((name) => !name.startsWith("@"));

  const batches: string[][] = [];
  for (let i = 0; i < unscoped.length; i += 100) {
    batches.push(unscoped.slice(i, i + 100));
  }

  await Promise.all([
    ...batches.map((batch) =>
      limit(async () => {
        const cacheKey = batch.join(",");
        const cached = readCache<Record<string, number>>("downloads-bulk", cacheKey);
        if (cached !== null) {
          for (const [name, count] of Object.entries(cached)) result.set(name, count);
          return;
        }
        try {
          const response = await fetchJson<BulkDownloadsResponse>(
            `${DOWNLOADS_API}/point/last-week/${batch.join(",")}`,
          );
          const collected: Record<string, number> = {};
          for (const [name, entry] of Object.entries(response)) {
            if (entry !== null && typeof entry.downloads === "number") {
              collected[name] = entry.downloads;
              result.set(name, entry.downloads);
            }
          }
          writeCache("downloads-bulk", cacheKey, collected);
        } catch {
          /* download counts are optional */
        }
      }),
    ),
    ...scoped.map((name) =>
      limit(async () => {
        const cached = readCache<number>("downloads-single", name);
        if (cached !== null) {
          result.set(name, cached);
          return;
        }
        try {
          const response = await fetchJson<SingleDownloadsResponse>(
            `${DOWNLOADS_API}/point/last-week/${encodePackageName(name)}`,
          );
          if (typeof response.downloads === "number") {
            result.set(name, response.downloads);
            writeCache("downloads-single", name, response.downloads);
          }
        } catch {
          /* download counts are optional */
        }
      }),
    ),
  ]);

  return result;
}
