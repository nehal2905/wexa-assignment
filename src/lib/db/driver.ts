import neo4j, { type Driver, type Record as Neo4jRecord } from "neo4j-driver";

import { getEnv } from "@/lib/env";
import { assertNoUndefinedParams, type Cypher, type Params } from "./cypher";
import { AppError, toAppError } from "./errors";
import { intToNumber } from "./serialize";

/**
 * Bolt driver lifecycle and query execution.
 *
 * ## Why a module-level singleton
 *
 * A `Driver` is a connection *pool*, not a connection. Creating one per request
 * would open a fresh TCP+TLS handshake every time — on a serverless platform
 * that is both slow and a fast route to exhausting the free tier's 200-connection
 * ceiling. One driver per process, reused across warm invocations, is the
 * documented pattern.
 *
 * The instance is parked on `globalThis` because Next.js's dev server reloads
 * modules on every edit; without this, an afternoon of development leaks a
 * driver per save.
 */

const DRIVER_KEY = Symbol.for("understory.bolt.driver");

interface DriverGlobal {
  [DRIVER_KEY]?: Driver;
}

const globalRef = globalThis as unknown as DriverGlobal;

/** Ceiling on any single query, so one pathological traversal can't pin the instance. */
const DEFAULT_QUERY_TIMEOUT_MS = 15_000;

/**
 * Reads a server-reported timing from a result summary.
 *
 * `resultAvailableAfter` and `resultConsumedAfter` are optional in the Bolt
 * protocol, and not every openCypher server populates them — CognoDB does not.
 * Treating them as guaranteed makes the *timing display* capable of failing the
 * *query*, which is exactly backwards: an unreported duration is a missing nicety,
 * not an error. Returns -1 when the server did not say, which the UI renders as
 * "not reported" rather than as a suspiciously fast 0 ms.
 */
function summaryMs(value: unknown): number {
  if (value === null || value === undefined) return -1;
  try {
    return intToNumber(value);
  } catch {
    return -1;
  }
}

export function getDriver(): Driver {
  const existing = globalRef[DRIVER_KEY];
  if (existing !== undefined) return existing;

  const env = getEnv();

  const driver = neo4j.driver(
    env.neo4jUri,
    neo4j.auth.basic(env.neo4jUsername, env.neo4jPassword),
    {
      // Sized for the CognoDB free (c0) tier. Each warm serverless instance holds
      // its own pool, so a large number here multiplies across instances.
      maxConnectionPoolSize: env.neo4jMaxPoolSize,

      // Fail fast and visibly rather than hanging a request for minutes.
      connectionTimeout: 15_000,
      connectionAcquisitionTimeout: 20_000,

      // Retry window for transient errors (leader switches, brief unavailability).
      maxTransactionRetryTime: 8_000,

      // Recycle connections before an idle proxy silently drops them.
      maxConnectionLifetime: 30 * 60 * 1000,

      userAgent: "understory/1.0.0",

      // NOTE: encryption is intentionally *not* configured here. It is implied by
      // the URI scheme (`bolt+s://` for CognoDB Cloud, plain `bolt://` locally),
      // and the driver throws if it is specified in both places.
    },
  );

  globalRef[DRIVER_KEY] = driver;
  return driver;
}

/** Closes the pool. Used by CLI scripts so the process can exit. */
export async function closeDriver(): Promise<void> {
  const driver = globalRef[DRIVER_KEY];
  if (driver === undefined) return;
  delete globalRef[DRIVER_KEY];
  await driver.close();
}

/* -------------------------------------------------------------------------- */
/* Query execution                                                             */
/* -------------------------------------------------------------------------- */

export interface QueryMeta {
  /** Server-side time until the first record was available. */
  availableAfterMs: number;
  /** Server-side time until the last record was consumed. */
  consumedAfterMs: number;
  /** Wall-clock round trip measured by us, including network. */
  roundTripMs: number;
  rowCount: number;
}

export interface QueryOutcome<T> {
  rows: T[];
  meta: QueryMeta;
}

export interface ReadArgs<T> {
  /** Must come from the query catalog — see `db/cypher.ts` for why. */
  statement: Cypher;
  params: Params;
  /** Row mapper. Runs inside the session so we never leak driver types outward. */
  map: (record: Neo4jRecord) => T;
  /** Short identifier used in logs and server-side transaction metadata. */
  label: string;
  timeoutMs?: number;
}

/**
 * Runs a read query in a managed read transaction.
 *
 * `executeRead` is used rather than a bare `session.run` because it gives us
 * automatic retry on transient failures and, on a clustered deployment, routes
 * to a follower instead of burdening the leader.
 */
export async function readRows<T>({
  statement,
  params,
  map,
  label,
  timeoutMs = DEFAULT_QUERY_TIMEOUT_MS,
}: ReadArgs<T>): Promise<QueryOutcome<T>> {
  assertNoUndefinedParams(params, label);

  const env = getEnv();
  const session = getDriver().session({
    database: env.neo4jDatabase,
    defaultAccessMode: neo4j.session.READ,
  });

  const startedAt = Date.now();
  try {
    const result = await session.executeRead(
      (tx) => tx.run(statement, params),
      { timeout: timeoutMs, metadata: { app: "understory", query: label } },
    );

    const roundTripMs = Date.now() - startedAt;
    return {
      rows: result.records.map(map),
      meta: {
        availableAfterMs: summaryMs(result.summary.resultAvailableAfter),
        consumedAfterMs: summaryMs(result.summary.resultConsumedAfter),
        roundTripMs,
        rowCount: result.records.length,
      },
    };
  } catch (error) {
    throw toAppError(error);
  } finally {
    await session.close();
  }
}

export interface WriteArgs {
  statement: Cypher;
  params: Params;
  label: string;
  timeoutMs?: number;
}

export interface WriteOutcome {
  nodesCreated: number;
  relationshipsCreated: number;
  propertiesSet: number;
  roundTripMs: number;
}

/** Runs a write query in a managed write transaction. Used by the seed pipeline. */
export async function writeRows({
  statement,
  params,
  label,
  timeoutMs = 60_000,
}: WriteArgs): Promise<WriteOutcome> {
  assertNoUndefinedParams(params, label);

  const env = getEnv();
  const session = getDriver().session({
    database: env.neo4jDatabase,
    defaultAccessMode: neo4j.session.WRITE,
  });

  const startedAt = Date.now();
  try {
    const result = await session.executeWrite(
      (tx) => tx.run(statement, params),
      { timeout: timeoutMs, metadata: { app: "understory", query: label } },
    );
    const counters = result.summary.counters.updates();
    return {
      nodesCreated: counters.nodesCreated,
      relationshipsCreated: counters.relationshipsCreated,
      propertiesSet: counters.propertiesSet,
      roundTripMs: Date.now() - startedAt,
    };
  } catch (error) {
    throw toAppError(error);
  } finally {
    await session.close();
  }
}

/**
 * Runs a statement in autocommit mode, outside any managed transaction.
 *
 * This exists solely for schema commands (`CREATE CONSTRAINT`, `CREATE INDEX`).
 * Those are DDL: several server versions refuse to run them inside an explicit
 * transaction, and they are idempotent via `IF NOT EXISTS`, so the retry
 * machinery that `executeWrite` provides buys us nothing here.
 */
export async function runAutocommit(statement: Cypher, label: string): Promise<void> {
  const env = getEnv();
  const session = getDriver().session({
    database: env.neo4jDatabase,
    defaultAccessMode: neo4j.session.WRITE,
  });
  try {
    await session.run(statement);
  } catch (error) {
    throw toAppError(error);
  } finally {
    await session.close();
  }
  void label;
}

/* -------------------------------------------------------------------------- */
/* Health                                                                      */
/* -------------------------------------------------------------------------- */

export interface HealthReport {
  ok: boolean;
  host: string;
  database: string;
  secure: boolean;
  latencyMs: number | null;
  serverAgent: string | null;
  protocolVersion: string | null;
  error: { code: string; message: string; hint?: string } | null;
}

/**
 * Cheap liveness probe. Used by `/api/health`, by the CLI (`npm run db:check`),
 * and by the UI's database-unreachable screen to offer a meaningful retry.
 */
export async function checkHealth(): Promise<HealthReport> {
  const startedAt = Date.now();

  let host = "unknown";
  let database = "unknown";
  let secure = false;

  try {
    const env = getEnv();
    host = env.displayHost;
    database = env.neo4jDatabase;
    secure = env.isSecure;

    const info = await getDriver().getServerInfo({ database: env.neo4jDatabase });

    return {
      ok: true,
      host,
      database,
      secure,
      latencyMs: Date.now() - startedAt,
      serverAgent: info.agent ?? null,
      protocolVersion: info.protocolVersion?.toString() ?? null,
      error: null,
    };
  } catch (error) {
    const app: AppError = toAppError(error);
    return {
      ok: false,
      host,
      database,
      secure,
      latencyMs: null,
      serverAgent: null,
      protocolVersion: null,
      error: {
        code: app.code,
        message: app.message,
        ...(app.hint !== undefined ? { hint: app.hint } : {}),
      },
    };
  }
}
