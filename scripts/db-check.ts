import { checkHealth, closeDriver } from "@/lib/db/driver";
import { fail, heading, ok, style, table } from "./cli";

/**
 * Connectivity check.
 *
 *   npm run db:check
 *
 * The first thing to run after filling in `.env.local`, and the first thing to
 * run when something looks wrong. It reports *why* a connection failed —
 * unreachable host, rejected credentials, wrong database name — rather than
 * leaving you to infer it from a driver stack trace.
 */
async function main(): Promise<void> {
  heading("Understory · connection check");

  const health = await checkHealth();

  table([
    ["host", health.host],
    ["database", health.database],
    ["encrypted", health.secure ? "yes" : `no ${style.dim("(fine for localhost)")}`],
  ]);

  process.stdout.write("\n");

  if (health.ok) {
    ok(`Connected in ${health.latencyMs} ms`);
    table([
      ["server", health.serverAgent ?? "unknown"],
      ["bolt protocol", health.protocolVersion ?? "unknown"],
    ]);
    process.stdout.write("\n");
    return;
  }

  fail(health.error?.message ?? "Connection failed.");
  if (health.error?.hint !== undefined) {
    process.stdout.write(`\n  ${style.dim(health.error.hint)}\n`);
  }
  process.stdout.write("\n");
  process.exitCode = 1;
}

main()
  .catch((error: unknown) => {
    fail(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => closeDriver());
