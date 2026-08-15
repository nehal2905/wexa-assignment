import Link from "next/link";

import { PackageSearch } from "@/components/package-search";

/**
 * 404.
 *
 * The most likely way to land here is searching for a package that is not in the
 * graph, so the page says exactly that and puts the search box back in front of
 * the user rather than making them navigate home first.
 */
export default function NotFound() {
  return (
    <div className="mx-auto w-full max-w-xl px-6 py-20 text-center">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-[var(--color-accent)]">
        Not in this graph
      </p>

      <h1 className="mt-3 text-2xl font-semibold tracking-tight">
        That package isn't in the dataset
      </h1>

      <p className="mx-auto mt-3 max-w-md text-[13.5px] leading-relaxed text-[var(--color-ink-muted)]">
        Understory holds a seeded slice of the npm registry - roughly two and a half thousand
        packages crawled outward from a set of well-known projects, not all two million.
        Plenty of perfectly real packages are legitimately absent.
      </p>

      <div className="mt-8">
        <PackageSearch placeholder="Try another package..." />
      </div>

      <Link
        href="/"
        className="mt-8 inline-block text-[13px] text-[var(--color-ink-muted)] underline decoration-[var(--color-line-strong)] underline-offset-4 transition-colors hover:text-[var(--color-accent)]"
      >
        Back to the seeded projects
      </Link>
    </div>
  );
}
