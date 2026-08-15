import { NextResponse } from "next/server";

import { logError, toAppError, toErrorBody } from "@/lib/db/errors";

/**
 * Shared plumbing for the handful of route handlers.
 *
 * Most of this application's data is fetched inside Server Components, which
 * call the query layer directly — no HTTP hop, no serialisation, no separate
 * error path. Routes exist only where the *browser* genuinely needs to fetch
 * something after the page has loaded: search-as-you-type, and the health probe.
 *
 * Those few routes still deserve consistent behaviour, which is what this file
 * provides: one error shape, one place that logs, and no route ever leaking a
 * driver stack trace into a response body.
 */

export type RouteHandler<T> = () => Promise<T>;

/**
 * Runs a handler and converts any failure into the standard error envelope.
 *
 * Every throw goes through `toAppError`, so a `ServiceUnavailable` from the
 * driver becomes a 503 with an actionable hint while an unexpected `TypeError`
 * becomes a generic 500 — and in neither case does the client see internals.
 */
export async function handleRoute<T>(
  context: string,
  handler: RouteHandler<T>,
): Promise<NextResponse> {
  try {
    const payload = await handler();
    return NextResponse.json(payload, {
      headers: {
        // These endpoints read live graph state; a cached "database is fine"
        // response would be actively misleading on the health probe.
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    const appError = toAppError(error);
    logError(context, error);
    return NextResponse.json(toErrorBody(appError), {
      status: appError.status,
      headers: { "cache-control": "no-store" },
    });
  }
}

/**
 * Reads a required string parameter, trimming and length-checking it.
 *
 * Length limits are not paranoia about injection — parameters go to the driver
 * out-of-band and cannot alter a statement (see `db/cypher.ts`). They are about
 * not asking a 0.5 vCPU instance to run a `CONTAINS` scan for a 4 KB string.
 */
export function requireParam(
  params: URLSearchParams,
  name: string,
  { maxLength = 214 }: { maxLength?: number } = {},
): string {
  const raw = params.get(name);
  if (raw === null || raw.trim() === "") {
    throw Object.assign(new Error(`Missing required query parameter "${name}".`), {
      code: "BAD_REQUEST",
    });
  }
  return raw.trim().slice(0, maxLength);
}

export function optionalInteger(
  params: URLSearchParams,
  name: string,
  fallback: number,
  { min, max }: { min: number; max: number },
): number {
  const raw = params.get(name);
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
