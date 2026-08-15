import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Environment configuration.
 *
 * Two hard rules drive this module:
 *
 *  1. Credentials are read from the environment and never from source. There is
 *     no fallback default password anywhere in this file — a missing variable is
 *     an error, not something we paper over with a guess.
 *  2. A misconfigured environment must produce an actionable message, not a
 *     `TypeError: Cannot read property 'uri' of undefined` five frames deep in
 *     the driver. Every failure below names the variable and says what to do.
 *
 * Both the Next.js app and the standalone `tsx` scripts import from here, so it
 * also carries a minimal .env loader for the script case (Next.js loads
 * .env.local itself; plain Node does not).
 */

export class ConfigurationError extends Error {
  readonly missing: readonly string[];

  constructor(message: string, missing: readonly string[] = []) {
    super(message);
    this.name = "ConfigurationError";
    this.missing = missing;
  }
}

/** Parsed, validated configuration. */
export interface Env {
  readonly neo4jUri: string;
  readonly neo4jUsername: string;
  readonly neo4jPassword: string;
  readonly neo4jDatabase: string;
  readonly neo4jMaxPoolSize: number;
  /** True when pointed at a `bolt+s://` / `neo4j+s://` (TLS) endpoint. */
  readonly isSecure: boolean;
  /** Host only, safe to log or show in a UI — never includes credentials. */
  readonly displayHost: string;
}

/* -------------------------------------------------------------------------- */
/* .env loading (for `tsx scripts/...`, which has no Next.js runtime)          */
/* -------------------------------------------------------------------------- */

let envFilesLoaded = false;

/**
 * Minimal .env reader. Loads `.env.local` then `.env`, and never overwrites a
 * variable that is already set — so real environment variables (Vercel, CI,
 * shell exports) always win over files on disk.
 *
 * This is intentionally ~30 lines rather than a `dotenv` dependency: the format
 * we actually use is `KEY=value` with optional quotes and `#` comments, and a
 * dependency here would be more code to audit than the code it replaces.
 */
export function loadEnvFiles(cwd: string = process.cwd()): void {
  if (envFilesLoaded) return;
  envFilesLoaded = true;

  for (const filename of [".env.local", ".env"]) {
    const path = resolve(cwd, filename);
    if (!existsSync(path)) continue;

    let contents: string;
    try {
      contents = readFileSync(path, "utf8");
    } catch {
      continue;
    }

    for (const rawLine of contents.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line === "" || line.startsWith("#")) continue;

      const eq = line.indexOf("=");
      if (eq === -1) continue;

      const key = line.slice(0, eq).trim();
      if (key === "" || key in process.env) continue;

      let value = line.slice(eq + 1).trim();
      const quoted =
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"));
      if (quoted && value.length >= 2) value = value.slice(1, -1);

      process.env[key] = value;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

const VALID_SCHEMES = [
  "bolt://",
  "bolt+s://",
  "bolt+ssc://",
  "neo4j://",
  "neo4j+s://",
  "neo4j+ssc://",
] as const;

function readInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new ConfigurationError(
      `${name} must be an integer, received "${raw}".`,
    );
  }
  return Math.min(max, Math.max(min, parsed));
}

function parseEnv(): Env {
  loadEnvFiles();

  const uri = process.env.NEO4J_URI?.trim();
  const username = process.env.NEO4J_USERNAME?.trim();
  const password = process.env.NEO4J_PASSWORD;

  const missing: string[] = [];
  if (!uri) missing.push("NEO4J_URI");
  if (!username) missing.push("NEO4J_USERNAME");
  if (!password) missing.push("NEO4J_PASSWORD");

  if (missing.length > 0) {
    throw new ConfigurationError(
      `Missing required environment variable${missing.length > 1 ? "s" : ""}: ${missing.join(", ")}. ` +
        `Copy .env.example to .env.local and fill in your CognoDB connection details ` +
        `(console.cognodb.com → your instance → Connect).`,
      missing,
    );
  }

  // Non-null assertions are safe: the `missing` check above returned otherwise.
  const safeUri = uri!;
  const safeUsername = username!;
  const safePassword = password!;

  if (!VALID_SCHEMES.some((scheme) => safeUri.startsWith(scheme))) {
    throw new ConfigurationError(
      `NEO4J_URI has an unsupported scheme: "${safeUri}". Expected one of ${VALID_SCHEMES.join(", ")}. ` +
        `CognoDB Cloud instances use bolt+s://<instance-id>.databases.cognodb.com`,
      ["NEO4J_URI"],
    );
  }

  if (safePassword.length === 0) {
    throw new ConfigurationError(
      "NEO4J_PASSWORD is set but empty. CognoDB shows the generated password exactly " +
        "once at instance creation — if you no longer have it, rotate it from the console.",
      ["NEO4J_PASSWORD"],
    );
  }

  let displayHost = safeUri;
  try {
    displayHost = new URL(safeUri).host || safeUri;
  } catch {
    /* keep the raw URI; it contains no credentials in Bolt form */
  }

  return {
    neo4jUri: safeUri,
    neo4jUsername: safeUsername,
    neo4jPassword: safePassword,
    neo4jDatabase: process.env.NEO4J_DATABASE?.trim() || "neo4j",
    neo4jMaxPoolSize: readInt("NEO4J_MAX_POOL_SIZE", 16, 1, 200),
    isSecure: safeUri.includes("+s://") || safeUri.includes("+ssc://"),
    displayHost,
  };
}

let cached: Env | null = null;

/**
 * Returns validated configuration, memoised for the lifetime of the process.
 * Throws {@link ConfigurationError} when the environment is incomplete.
 */
export function getEnv(): Env {
  if (cached === null) cached = parseEnv();
  return cached;
}

/**
 * Non-throwing variant. API routes use this so that a clone-and-run with no
 * `.env.local` renders a helpful setup screen instead of a 500 with a stack
 * trace.
 */
export function tryGetEnv():
  | { ok: true; env: Env }
  | { ok: false; error: ConfigurationError } {
  try {
    return { ok: true, env: getEnv() };
  } catch (error) {
    if (error instanceof ConfigurationError) return { ok: false, error };
    throw error;
  }
}

/** Test seam — clears the memoised value. */
export function resetEnvCache(): void {
  cached = null;
  envFilesLoaded = false;
}
