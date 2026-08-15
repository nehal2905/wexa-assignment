import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";

/**
 * HTTP plumbing for the seed pipeline: polite concurrency, retry with backoff,
 * and an on-disk cache.
 *
 * The cache is the important part. Seeding walks ~900 packages across two public
 * APIs; without caching, every iteration on the loader or the data model would
 * re-download tens of megabytes and re-hammer registry.npmjs.org. With it, a
 * second run is effectively instant and entirely offline. The cache lives in
 * `scripts/seed/.cache/` and is gitignored - it is derived data, regenerable at
 * any time by deleting the directory.
 */

const CACHE_DIR = resolve(process.cwd(), "scripts/seed/.cache");

/**
 * Bump when the *shape* of a cached record changes, so stale entries written by
 * an older extractor are ignored rather than silently reused.
 */
export const CACHE_VERSION = "v2";

export class HttpError extends Error {
  readonly status: number;
  readonly url: string;

  constructor(status: number, url: string, message?: string) {
    super(message ?? `HTTP ${status} for ${url}`);
    this.name = "HttpError";
    this.status = status;
    this.url = url;
  }
}

/* -------------------------------------------------------------------------- */
/* Disk cache                                                                  */
/* -------------------------------------------------------------------------- */

function cachePath(namespace: string, key: string): string {
  // Package names contain `/`, `@`, and `.` - none of which are safe as path
  // segments on every platform. Hash for a flat, collision-resistant filename,
  // and keep a readable prefix so the cache is browsable during debugging.
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 16);
  const readable = key.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 48);
  return resolve(CACHE_DIR, namespace, `${readable}.${digest}.json`);
}

export function readCache<T>(namespace: string, key: string): T | null {
  const path = cachePath(namespace, key);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      version?: string;
      value?: T;
    };
    if (parsed.version !== CACHE_VERSION) return null;
    return (parsed.value ?? null) as T | null;
  } catch {
    // A truncated or corrupt cache entry is not worth reporting - just refetch.
    return null;
  }
}

export function writeCache<T>(namespace: string, key: string, value: T): void {
  const path = cachePath(namespace, key);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: CACHE_VERSION, value }), "utf8");
}

/* -------------------------------------------------------------------------- */
/* Fetching                                                                    */
/* -------------------------------------------------------------------------- */

const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

export interface FetchOptions {
  headers?: Record<string, string>;
  method?: "GET" | "POST";
  body?: unknown;
  /** Total attempts, including the first. */
  attempts?: number;
  timeoutMs?: number;
}

/**
 * Fetches JSON with exponential backoff and jitter.
 *
 * Jitter matters: the crawler runs several requests concurrently, and without it
 * a 429 from the registry would cause every in-flight request to retry in
 * lockstep, reproducing the burst that caused the rate-limit in the first place.
 */
export async function fetchJson<T>(url: string, options: FetchOptions = {}): Promise<T> {
  const { headers = {}, method = "GET", body, attempts = 4, timeoutMs = 30_000 } = options;

  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method,
        signal: controller.signal,
        headers: {
          // The registry asks that clients identify themselves.
          "user-agent": "understory-seed/1.0 (+https://github.com/understory)",
          accept: "application/json",
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
          ...headers,
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });

      if (!response.ok) {
        if (RETRYABLE_STATUSES.has(response.status) && attempt < attempts) {
          const retryAfter = Number(response.headers.get("retry-after"));
          const backoff = Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : 2 ** attempt * 250 + Math.random() * 250;
          await sleep(backoff);
          continue;
        }
        throw new HttpError(response.status, url);
      }

      return (await response.json()) as T;
    } catch (error) {
      lastError = error;
      // A 404 is a real answer ("no such package"), not a transient failure.
      if (error instanceof HttpError && !RETRYABLE_STATUSES.has(error.status)) throw error;
      if (attempt === attempts) break;
      await sleep(2 ** attempt * 250 + Math.random() * 250);
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Failed to fetch ${url} after ${attempts} attempts`);
}

/* -------------------------------------------------------------------------- */
/* Concurrency                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * A minimal concurrency limiter - the `p-limit` shape, in fifteen lines.
 *
 * Written out rather than pulled in because the whole contract is "run at most N
 * of these at once", and a dependency for that is more supply-chain surface than
 * the code it saves. Which, given what this application is about, would be a
 * slightly embarrassing thing to get wrong.
 */
export function createLimiter(concurrency: number): <T>(task: () => Promise<T>) => Promise<T> {
  const queue: Array<() => void> = [];
  let active = 0;

  const next = (): void => {
    if (active >= concurrency) return;
    const run = queue.shift();
    if (run === undefined) return;
    active += 1;
    run();
  };

  return function limit<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((fulfil, reject) => {
      queue.push(() => {
        task()
          .then(fulfil, reject)
          .finally(() => {
            active -= 1;
            next();
          });
      });
      next();
    });
  };
}
