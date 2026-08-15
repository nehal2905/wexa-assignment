import { checkHealth } from "@/lib/db/driver";
import { tryGetEnv } from "@/lib/env";

/**
 * Liveness probe for the graph connection.
 *
 * Returns 200 when the database answered and 503 when it did not, so it works
 * as an uptime check as well as feeding the connection indicator in the UI.
 * Deliberately never throws: an unconfigured deployment should report *why* it
 * is unhealthy, not return an opaque 500.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const env = tryGetEnv();

  if (!env.ok) {
    return Response.json(
      {
        ok: false,
        configured: false,
        error: { code: "CONFIGURATION", message: env.error.message, missing: env.error.missing },
      },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }

  const health = await checkHealth();

  return Response.json(
    {
      ok: health.ok,
      configured: true,
      // Host is safe to expose: a Bolt URI carries no credentials, and knowing
      // which instance a deployment points at is useful when debugging.
      host: health.host,
      database: health.database,
      encrypted: health.secure,
      latencyMs: health.latencyMs,
      server: health.serverAgent,
      boltProtocol: health.protocolVersion,
      error: health.error,
    },
    { status: health.ok ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}
