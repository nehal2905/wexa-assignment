"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

/**
 * "Try again" for a server-rendered error page.
 *
 * `router.refresh()` re-runs the server render for the current route without a
 * full document reload, so the whole app shell, fonts and client state survive
 * - and if the database has come back, the page simply fills in. `useTransition`
 * gives us a real pending state, which matters here: a retry against a database
 * that is still down takes as long as the connection timeout, and a button that
 * looks inert for fifteen seconds reads as broken.
 */
export function RetryButton() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [attempts, setAttempts] = useState(0);

  return (
    <div className="flex flex-wrap items-center gap-3">
      <button
        type="button"
        disabled={isPending}
        onClick={() => {
          setAttempts((count) => count + 1);
          startTransition(() => router.refresh());
        }}
        className="inline-flex items-center gap-2 rounded-lg bg-[var(--color-accent)] px-3.5 py-2 text-[13px] font-semibold text-[#04110c] transition-opacity hover:opacity-90 disabled:cursor-wait disabled:opacity-60"
      >
        {isPending && (
          <span
            aria-hidden
            className="h-3 w-3 animate-spin rounded-full border-2 border-[#04110c]/30 border-t-[#04110c]"
          />
        )}
        {isPending ? "Reconnecting..." : "Try again"}
      </button>

      {attempts > 0 && !isPending && (
        <span className="text-[12px] text-[var(--color-ink-faint)]" role="status">
          Still unreachable after {attempts} attempt{attempts === 1 ? "" : "s"}.
        </span>
      )}
    </div>
  );
}
