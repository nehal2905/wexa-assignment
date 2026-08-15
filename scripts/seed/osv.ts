import semver from "semver";

import { bestCvssScore } from "./cvss";
import { createLimiter, fetchJson, HttpError, readCache, writeCache } from "./http";
import {
  normaliseSeverity,
  severityFromCvss,
  versionKey,
  type Severity,
} from "@/lib/graph/model";

/**
 * Client for OSV.dev — Google's open vulnerability database, which aggregates
 * GitHub Security Advisories, CVEs, and ecosystem-specific sources.
 *
 * Two calls are involved, and the split matters for correctness:
 *
 *  1. `POST /v1/querybatch` — given (package, version) pairs, returns which
 *     advisory IDs apply. **OSV performs the range matching**, so we do not have
 *     to reimplement "is 4.17.20 inside `>=4.0.0 <4.17.21`" for every advisory
 *     format. This is why the graph stores resolved versions: it lets us ask the
 *     authoritative source a precise question.
 *
 *  2. `GET /v1/vulns/{id}` — full advisory detail for each unique ID.
 *
 * Both are cached to disk per entity, so re-running the seed does not re-query.
 */

const OSV_API = "https://api.osv.dev/v1";

/** OSV accepts up to 1000 queries per batch; 100 keeps payloads small and errors cheap. */
const BATCH_SIZE = 100;

/* -------------------------------------------------------------------------- */
/* Raw OSV shapes (only the fields we read)                                    */
/* -------------------------------------------------------------------------- */

interface RawEvent {
  introduced?: string;
  fixed?: string;
  last_affected?: string;
}

interface RawRange {
  type?: string;
  events?: RawEvent[];
}

interface RawAffected {
  package?: { name?: string; ecosystem?: string };
  ranges?: RawRange[];
  versions?: string[];
}

interface RawAdvisory {
  id?: string;
  aliases?: string[];
  summary?: string;
  details?: string;
  published?: string;
  severity?: Array<{ type?: string; score?: string }>;
  references?: Array<{ type?: string; url?: string }>;
  affected?: RawAffected[];
  database_specific?: { severity?: string; cwe_ids?: string[] };
}

interface RawBatchResponse {
  results?: Array<{ vulns?: Array<{ id?: string }> }>;
}

/* -------------------------------------------------------------------------- */
/* Parsed shapes                                                               */
/* -------------------------------------------------------------------------- */

export interface AffectedWindow {
  introducedIn: string | null;
  fixedIn: string | null;
}

export interface Advisory {
  id: string;
  aliases: string[];
  severity: Severity;
  cvssScore: number | null;
  summary: string;
  details: string | null;
  url: string | null;
  published: string | null;
  cwes: string[];
  /** Affected windows keyed by npm package name, used to build AFFECTS edges. */
  windows: Record<string, AffectedWindow[]>;
}

/* -------------------------------------------------------------------------- */
/* Reachability query                                                          */
/* -------------------------------------------------------------------------- */

export interface VersionRef {
  name: string;
  version: string;
}

/**
 * Maps each `name@version` to the advisory IDs affecting it.
 *
 * Cached per version rather than per batch: batch composition changes whenever
 * the crawl changes, and a per-batch cache would miss on every run.
 */
export async function findVulnerabilityIds(
  refs: readonly VersionRef[],
  concurrency: number,
  onProgress?: (done: number, total: number) => void,
): Promise<Map<string, string[]>> {
  const found = new Map<string, string[]>();
  const misses: VersionRef[] = [];

  for (const ref of refs) {
    const key = versionKey(ref.name, ref.version);
    const cached = readCache<string[]>("osv-query", key);
    if (cached !== null) {
      if (cached.length > 0) found.set(key, cached);
    } else {
      misses.push(ref);
    }
  }

  const batches: VersionRef[][] = [];
  for (let i = 0; i < misses.length; i += BATCH_SIZE) {
    batches.push(misses.slice(i, i + BATCH_SIZE));
  }

  const limit = createLimiter(concurrency);
  let completed = 0;

  await Promise.all(
    batches.map((batch) =>
      limit(async () => {
        const response = await fetchJson<RawBatchResponse>(`${OSV_API}/querybatch`, {
          method: "POST",
          body: {
            queries: batch.map((ref) => ({
              package: { name: ref.name, ecosystem: "npm" },
              version: ref.version,
            })),
          },
        });

        // Results are positionally aligned with the queries we sent. If OSV
        // returns a shorter array we treat the tail as "no vulnerabilities"
        // rather than misaligning every subsequent entry.
        const results = response.results ?? [];
        batch.forEach((ref, index) => {
          const key = versionKey(ref.name, ref.version);
          const ids = (results[index]?.vulns ?? [])
            .map((vuln) => vuln.id)
            .filter((id): id is string => typeof id === "string");
          writeCache("osv-query", key, ids);
          if (ids.length > 0) found.set(key, ids);
        });

        completed += 1;
        onProgress?.(completed, batches.length);
      }),
    ),
  );

  return found;
}

/* -------------------------------------------------------------------------- */
/* Advisory detail                                                             */
/* -------------------------------------------------------------------------- */

function parseAdvisory(raw: RawAdvisory, id: string): Advisory {
  const cvssScore = bestCvssScore(raw.severity);

  // Prefer the advisory's own severity band; fall back to deriving one from the
  // CVSS score. GitHub-sourced advisories almost always carry the former, but
  // advisories imported from other sources frequently do not.
  const declared = normaliseSeverity(raw.database_specific?.severity);
  const severity: Severity = declared !== "UNKNOWN" ? declared : severityFromCvss(cvssScore);

  const windows: Record<string, AffectedWindow[]> = {};
  for (const affected of raw.affected ?? []) {
    if (affected.package?.ecosystem !== "npm") continue;
    const name = affected.package.name;
    if (name === undefined) continue;

    const collected: AffectedWindow[] = [];
    for (const range of affected.ranges ?? []) {
      let introducedIn: string | null = null;
      for (const event of range.events ?? []) {
        if (event.introduced !== undefined) {
          // OSV uses "0" to mean "from the beginning of time".
          introducedIn = event.introduced === "0" ? null : event.introduced;
        } else if (event.fixed !== undefined) {
          collected.push({ introducedIn, fixedIn: event.fixed });
          introducedIn = null;
        } else if (event.last_affected !== undefined) {
          collected.push({ introducedIn, fixedIn: null });
          introducedIn = null;
        }
      }
      // An `introduced` with no closing event means "still unpatched".
      if (introducedIn !== null) collected.push({ introducedIn, fixedIn: null });
    }

    if (collected.length === 0 && (affected.versions?.length ?? 0) > 0) {
      collected.push({ introducedIn: null, fixedIn: null });
    }

    windows[name] = collected;
  }

  const advisoryUrl =
    raw.references?.find((reference) => reference.type === "ADVISORY")?.url ??
    raw.references?.[0]?.url ??
    (id.startsWith("GHSA") ? `https://github.com/advisories/${id}` : null);

  return {
    id,
    aliases: raw.aliases ?? [],
    severity,
    cvssScore,
    summary: raw.summary?.trim() || "No summary provided by the advisory.",
    details: raw.details?.trim() || null,
    url: advisoryUrl,
    published: raw.published ?? null,
    cwes: raw.database_specific?.cwe_ids ?? [],
    windows,
  };
}

export async function fetchAdvisories(
  ids: readonly string[],
  concurrency: number,
  onProgress?: (done: number, total: number) => void,
): Promise<Map<string, Advisory>> {
  const advisories = new Map<string, Advisory>();
  const limit = createLimiter(concurrency);
  let completed = 0;

  await Promise.all(
    ids.map((id) =>
      limit(async () => {
        try {
          const cached = readCache<Advisory>("osv-vuln", id);
          if (cached !== null) {
            advisories.set(id, cached);
            return;
          }
          const raw = await fetchJson<RawAdvisory>(`${OSV_API}/vulns/${encodeURIComponent(id)}`);
          const parsed = parseAdvisory(raw, id);
          writeCache("osv-vuln", id, parsed);
          advisories.set(id, parsed);
        } catch (error) {
          // A withdrawn advisory 404s after being referenced by querybatch.
          // Skip it rather than aborting the run.
          if (!(error instanceof HttpError && error.status === 404)) throw error;
        } finally {
          completed += 1;
          onProgress?.(completed, ids.length);
        }
      }),
    ),
  );

  return advisories;
}

/**
 * Selects the affected window that actually contains `version`, so the UI can
 * say "affected from 4.0.0, fixed in 4.17.21" rather than showing every window
 * the advisory lists.
 */
export function windowForVersion(
  advisory: Advisory,
  packageName: string,
  version: string,
): AffectedWindow {
  const candidates = advisory.windows[packageName] ?? [];
  const parsed = semver.parse(version);

  for (const window of candidates) {
    const afterIntroduced =
      window.introducedIn === null ||
      (parsed !== null && semver.gte(version, window.introducedIn, { loose: true }));
    const beforeFixed =
      window.fixedIn === null ||
      (parsed !== null && semver.lt(version, window.fixedIn, { loose: true }));

    if (afterIntroduced && beforeFixed) return window;
  }

  return candidates[0] ?? { introducedIn: null, fixedIn: null };
}
