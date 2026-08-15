"use client";

import { useRouter, useSearchParams } from "next/navigation";

import { PackageSearch } from "@/components/package-search";

/**
 * A search box that writes its selection into a named search parameter instead
 * of navigating to the package page.
 *
 * Used by the two-input tools (compare, trace a path). Keeping the selection in
 * the URL rather than component state means both halves of a comparison are
 * shareable as a single link, and the server can render the result directly.
 */
export function PackagePicker({
  param,
  label,
  placeholder,
  selected,
}: {
  param: string;
  label: string;
  placeholder: string;
  selected: string | null;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function set(value: string | null) {
    const next = new URLSearchParams(searchParams.toString());
    if (value === null) next.delete(param);
    else next.set(param, value);
    router.push(`?${next.toString()}`, { scroll: false });
  }

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <label className="text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--color-ink-faint)]">
          {label}
        </label>
        {selected !== null && (
          <button
            type="button"
            onClick={() => set(null)}
            className="text-[11.5px] text-[var(--color-ink-faint)] underline decoration-[var(--color-line-strong)] underline-offset-4 transition-colors hover:text-[var(--color-ink-muted)]"
          >
            clear
          </button>
        )}
      </div>

      {selected === null ? (
        <PackageSearch
          size="compact"
          placeholder={placeholder}
          onPick={(hit) => set(hit.name)}
        />
      ) : (
        <div className="flex h-10 items-center rounded-xl border border-[var(--color-accent-dim)] bg-[var(--color-accent-ghost)] px-3.5">
          <span className="truncate font-mono text-[13.5px] text-[var(--color-accent)]">
            {selected}
          </span>
        </div>
      )}
    </div>
  );
}
