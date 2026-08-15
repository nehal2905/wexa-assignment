import Link from "next/link";
import type { AppError, ErrorCode } from "@/lib/db/errors";
import { RetryButton } from "./retry-button";

/**
 * What the user sees when the graph cannot be reached.
 *
 * The brief for this project asks for graceful handling when the database is
 * unreachable, and the temptation is to render "Something went wrong" and move
 * on. That is not graceful, it is just quiet. This component is built on the
 * premise that the person looking at it needs to know three things: what failed,
 * whether it is their fault, and what to do next — and that those answers differ
 * completely depending on the failure.
 *
 * The `code` on {@link AppError} is a closed set (see `db/errors.ts`), so each
 * case can be addressed specifically rather than through generic prose.
 */

interface Guidance {
  headline: string;
  explanation: string;
  steps: string[];
  showRetry: boolean;
}

const GUIDANCE: Record<ErrorCode, Guidance> = {
  DB_UNAVAILABLE: {
    headline: "The graph database is not responding",
    explanation:
      "Understory reached out to its CognoDB instance and got no answer. Everything on this page comes from live graph queries, so there is nothing meaningful to show until the connection is back.",
    steps: [
      "Check the instance is running at console.cognodb.com — free-tier instances can be paused after a period of inactivity.",
      "Confirm NEO4J_URI in your environment matches the connection string shown in the console.",
      "If you are running locally, check the database container is up: docker compose ps",
    ],
    showRetry: true,
  },
  DB_AUTH: {
    headline: "The database refused our credentials",
    explanation:
      "The instance is reachable, which rules out networking — but it rejected the username and password we presented.",
    steps: [
      "CognoDB instances use the username cognodb, not neo4j.",
      "The generated password is shown only once at creation. If it was not saved, rotate it from the console.",
      "Check NEO4J_PASSWORD has no stray quotes or trailing whitespace.",
    ],
    showRetry: true,
  },
  CONFIGURATION: {
    headline: "Understory has not been configured yet",
    explanation:
      "The connection details are read entirely from environment variables, and at least one required value is missing or malformed. No credentials are ever committed to the repository, so a fresh clone always needs this step.",
    steps: [
      "Copy .env.example to .env.local",
      "Fill in NEO4J_URI, NEO4J_USERNAME and NEO4J_PASSWORD from your CognoDB console",
      "Verify the connection with: npm run db:check",
      "Populate the graph with: npm run db:seed",
    ],
    showRetry: false,
  },
  DB_TIMEOUT: {
    headline: "That query took too long",
    explanation:
      "The traversal was cancelled before it finished. The free tier runs on a fraction of a CPU, so an unusually wide dependency tree can occasionally exceed the time budget.",
    steps: [
      "Try a smaller traversal depth on the graph view.",
      "Narrow the severity filter to reduce the number of paths being computed.",
    ],
    showRetry: true,
  },
  NOT_FOUND: {
    headline: "Not in this graph",
    explanation:
      "The dataset is a seeded slice of the npm registry, not the whole of it, so plenty of real packages are legitimately absent.",
    steps: ["Search for a different package, or start from one of the seeded applications."],
    showRetry: false,
  },
  BAD_REQUEST: {
    headline: "That request did not make sense",
    explanation: "One of the values in the URL was missing or malformed.",
    steps: ["Head back and try again from a link rather than a hand-edited URL."],
    showRetry: false,
  },
  INTERNAL: {
    headline: "Something broke on our side",
    explanation:
      "This one is a bug in Understory rather than anything you did. The details have been written to the server log.",
    steps: ["Retrying is worth a shot; if it persists, it needs a fix in the code."],
    showRetry: true,
  },
};

export function DatabaseError({ error }: { error: AppError }) {
  const guidance = GUIDANCE[error.code];

  return (
    <div className="mx-auto w-full max-w-2xl px-6 py-16">
      <div className="surface-card overflow-hidden">
        <div className="border-b border-[var(--color-line)] bg-[var(--color-critical-ghost)] px-6 py-5">
          <div className="flex items-start gap-3.5">
            <span
              aria-hidden
              className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-[color-mix(in_oklab,var(--color-critical)_40%,transparent)] text-[13px] text-[var(--color-critical)]"
            >
              !
            </span>
            <div className="min-w-0">
              <h1 className="text-base font-semibold tracking-tight text-[var(--color-ink)]">
                {guidance.headline}
              </h1>
              <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.12em] text-[var(--color-critical)]">
                {error.code}
              </p>
            </div>
          </div>
        </div>

        <div className="px-6 py-5">
          <p className="text-[13.5px] leading-relaxed text-[var(--color-ink-muted)]">
            {guidance.explanation}
          </p>

          {/* The mapped hint from the error itself, when it adds something the
              static guidance above does not already say. */}
          {error.hint !== undefined && (
            <p className="mt-4 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-raised)] px-4 py-3 text-[13px] leading-relaxed text-[var(--color-ink-muted)]">
              {error.hint}
            </p>
          )}

          <h2 className="mt-6 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--color-ink-faint)]">
            What to try
          </h2>
          <ol className="mt-3 space-y-2.5">
            {guidance.steps.map((stepText, index) => (
              <li key={stepText} className="flex gap-3 text-[13px] leading-relaxed">
                <span className="tabular mt-px shrink-0 font-mono text-[11px] text-[var(--color-ink-faint)]">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span className="text-[var(--color-ink-muted)]">{stepText}</span>
              </li>
            ))}
          </ol>

          <div className="mt-7 flex flex-wrap items-center gap-3">
            {guidance.showRetry && <RetryButton />}
            <Link
              href="/"
              className="rounded-lg border border-[var(--color-line-strong)] px-3.5 py-2 text-[13px] font-medium text-[var(--color-ink-muted)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-ink)]"
            >
              Back to start
            </Link>
          </div>
        </div>
      </div>

      <p className="mt-5 text-center text-[12px] leading-relaxed text-[var(--color-ink-faint)]">
        Understory holds no data of its own — every panel is a live query against the graph.
      </p>
    </div>
  );
}

/** Small client island so "Try again" re-runs the current request. */
function RetryLink() {
  return (
    <a
      href=""
      className="rounded-lg bg-[var(--color-accent)] px-3.5 py-2 text-[13px] font-semibold text-[#04110c] transition-opacity hover:opacity-90"
    >
      Try again
    </a>
  );
}
