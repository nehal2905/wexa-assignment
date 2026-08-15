import type { ReactNode } from "react";

/**
 * Presentational primitives.
 *
 * All server components - none of them hold state, so none of them need to ship
 * JavaScript to the browser. Only the graph canvas, the search box and the
 * filter controls are client components, which keeps the bundle small enough
 * that the app is usable on a slow connection.
 */

export function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter(Boolean).join(" ");
}

/* -------------------------------------------------------------------------- */
/* Layout                                                                      */
/* -------------------------------------------------------------------------- */

export function Panel({
  title,
  description,
  aside,
  children,
  className,
}: {
  title?: string;
  description?: string;
  aside?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cx("surface-card overflow-hidden", className)}>
      {title !== undefined && (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-[var(--color-line)] px-5 py-4">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold tracking-tight text-[var(--color-ink)]">{title}</h2>
            {description !== undefined && (
              <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-[var(--color-ink-muted)]">
                {description}
              </p>
            )}
          </div>
          {aside !== undefined && <div className="shrink-0">{aside}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function SectionHeading({
  eyebrow,
  title,
  description,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
}) {
  return (
    <div className="mb-5">
      {eyebrow !== undefined && (
        <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.16em] text-[var(--color-accent)]">
          {eyebrow}
        </p>
      )}
      <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
      {description !== undefined && (
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-[var(--color-ink-muted)]">
          {description}
        </p>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Data display                                                                */
/* -------------------------------------------------------------------------- */

export function Stat({
  label,
  value,
  hint,
  tone = "default",
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: "default" | "critical" | "high" | "good";
}) {
  const toneClass =
    tone === "critical"
      ? "text-[var(--color-critical)]"
      : tone === "high"
        ? "text-[var(--color-high)]"
        : tone === "good"
          ? "text-[var(--color-accent)]"
          : "text-[var(--color-ink)]";

  return (
    <div className="px-5 py-4">
      <dt className="text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--color-ink-faint)]">
        {label}
      </dt>
      <dd className={cx("tabular mt-1.5 text-2xl font-semibold tracking-tight", toneClass)}>
        {value}
      </dd>
      {hint !== undefined && (
        <p className="mt-1 text-[12px] leading-snug text-[var(--color-ink-faint)]">{hint}</p>
      )}
    </div>
  );
}

export function Badge({
  children,
  className,
  title,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cx(
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 font-mono text-[11px] font-medium leading-5",
        className ?? "border-[var(--color-line-strong)] bg-[var(--color-surface-raised)] text-[var(--color-ink-muted)]",
      )}
    >
      {children}
    </span>
  );
}

/** Monospace inline code, used for package names and version keys. */
export function Code({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <code
      className={cx(
        "rounded bg-[var(--color-surface-raised)] px-1.5 py-0.5 font-mono text-[12.5px] text-[var(--color-ink)]",
        className,
      )}
    >
      {children}
    </code>
  );
}

/* -------------------------------------------------------------------------- */
/* States                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Empty state.
 *
 * Deliberately explicit about *why* there is nothing here. "No results" leaves a
 * user unsure whether the tool is broken or the answer is genuinely nothing -
 * and in a security tool those two readings could not be more different.
 */
export function EmptyState({
  title,
  description,
  icon = "o",
  action,
}: {
  title: string;
  description: string;
  icon?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <div
        aria-hidden
        className="mb-4 flex h-10 w-10 items-center justify-center rounded-full border border-[var(--color-line-strong)] text-[var(--color-ink-faint)]"
      >
        {icon}
      </div>
      <p className="text-sm font-medium text-[var(--color-ink)]">{title}</p>
      <p className="mt-1.5 max-w-md text-[13px] leading-relaxed text-[var(--color-ink-muted)]">
        {description}
      </p>
      {action !== undefined && <div className="mt-5">{action}</div>}
    </div>
  );
}

/** Skeleton block used by Suspense fallbacks. */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("shimmer rounded-md", className)} aria-hidden />;
}

export function PanelSkeleton({ rows = 4, title }: { rows?: number; title?: string }) {
  return (
    <div className="surface-card overflow-hidden" aria-busy="true" aria-live="polite">
      <div className="border-b border-[var(--color-line)] px-5 py-4">
        {title !== undefined ? (
          <h2 className="text-sm font-semibold tracking-tight text-[var(--color-ink)]">{title}</h2>
        ) : (
          <Skeleton className="h-4 w-40" />
        )}
        <Skeleton className="mt-2 h-3 w-72" />
      </div>
      <div className="space-y-3 px-5 py-5">
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className="flex items-center gap-3">
            <Skeleton className="h-8 w-8 shrink-0 rounded-full" />
            <Skeleton className="h-3 flex-1" />
            <Skeleton className="h-3 w-16 shrink-0" />
          </div>
        ))}
      </div>
      <span className="sr-only">Loading...</span>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Query provenance                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Footer strip showing which catalog query produced a panel and how long the
 * database took.
 *
 * This is not decoration. It makes the graph work visible - a reader can see
 * that the maintainer panel really is a traversal, follow the link to the exact
 * Cypher, and check the server-side timing themselves.
 */
export function QueryFootnote({
  queryId,
  serverMs,
  rowCount,
}: {
  queryId: string;
  /** -1 when the server did not report a duration - see `summaryMs` in db/driver.ts. */
  serverMs: number;
  rowCount?: number;
}) {
  return (
    <footer className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--color-line)] bg-[var(--color-ground)]/40 px-5 py-2.5 font-mono text-[11px] text-[var(--color-ink-faint)]">
      <a
        href={`/queries#${queryId}`}
        className="text-[var(--color-ink-muted)] underline decoration-[var(--color-line-strong)] underline-offset-4 transition-colors hover:text-[var(--color-accent)]"
      >
        {queryId}
      </a>
      <span aria-hidden>|</span>
      {/* Not every openCypher server reports query timing over Bolt. Saying so is
          better than printing a made-up 0 ms. */}
      <span className="tabular">
        {serverMs < 0 ? "live graph query" : `${serverMs} ms in the graph`}
      </span>
      {rowCount !== undefined && (
        <>
          <span aria-hidden>|</span>
          <span className="tabular">
            {rowCount} row{rowCount === 1 ? "" : "s"}
          </span>
        </>
      )}
    </footer>
  );
}
