import type { NextRequest } from "next/server";

import { handleRoute, optionalInteger } from "@/lib/api";
import { searchPackages } from "@/lib/queries/discovery";

/**
 * Package search, for the type-ahead in the header and the pickers.
 *
 * `nodejs` runtime, not edge: the Neo4j driver speaks Bolt over a raw TCP
 * socket, which the edge runtime has no way to open.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  return handleRoute("GET /api/search", async () => {
    const params = request.nextUrl.searchParams;
    const term = (params.get("q") ?? "").trim().slice(0, 214);
    const limit = optionalInteger(params, "limit", 8, { min: 1, max: 25 });

    // A single character matches most of the graph and is never a useful
    // result set - answer immediately rather than making the database scan.
    if (term.length < 2) {
      return { results: [], term, tookMs: 0 };
    }

    const { rows, meta } = await searchPackages(term, limit);
    return { results: rows, term, tookMs: meta.consumedAfterMs };
  });
}
