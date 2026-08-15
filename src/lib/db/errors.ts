import { Neo4jError } from "neo4j-driver";
import { ConfigurationError } from "@/lib/env";

/**
 * A single, closed set of failure modes the application knows how to talk about.
 *
 * The point of this module is that *every* error surfaced to a user or an HTTP
 * client has been through `toAppError`. Nothing raw from the driver, the network
 * stack, or `JSON.parse` reaches a response body - so we never leak a
 * connection string, a stack trace, or a Cypher statement to the browser, and
 * the UI always has a stable `code` to branch on.
 */
export type ErrorCode =
  | "CONFIGURATION" // env vars missing or malformed
  | "DB_UNAVAILABLE" // cannot reach the database at all
  | "DB_AUTH" // reached it, credentials rejected
  | "DB_TIMEOUT" // reached it, query took too long
  | "NOT_FOUND" // valid request, no such entity
  | "BAD_REQUEST" // caller's fault
  | "INTERNAL"; // our fault

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  CONFIGURATION: 503,
  DB_UNAVAILABLE: 503,
  DB_AUTH: 503,
  DB_TIMEOUT: 504,
  NOT_FOUND: 404,
  BAD_REQUEST: 400,
  INTERNAL: 500,
};

export interface AppErrorOptions {
  /** Actionable next step, shown beneath the message in the UI. */
  hint?: string;
  /** Original error, kept for server-side logging only - never serialised. */
  cause?: unknown;
  /** Whether retrying the same request might succeed. */
  retryable?: boolean;
}

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly hint: string | undefined;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "AppError";
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.hint = options.hint;
    this.retryable = options.retryable ?? (code === "DB_UNAVAILABLE" || code === "DB_TIMEOUT");
  }
}

/** Shape returned to the browser. Deliberately small and free of internals. */
export interface ErrorBody {
  error: {
    code: ErrorCode;
    message: string;
    hint?: string;
    retryable: boolean;
  };
}

export function toErrorBody(error: AppError): ErrorBody {
  return {
    error: {
      code: error.code,
      message: error.message,
      ...(error.hint !== undefined ? { hint: error.hint } : {}),
      retryable: error.retryable,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Mapping                                                                     */
/* -------------------------------------------------------------------------- */

/** Node-level socket/DNS/TLS failures that mean "the database is not reachable". */
const UNREACHABLE_SYSCALL_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
]);

function systemErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Normalises anything thrown anywhere in the data path into an {@link AppError}.
 *
 * The Neo4j driver reports connectivity problems as `Neo4jError` with a small
 * set of well-known `code` values, and server-side problems with dotted
 * `Neo.<Class>.<Category>.<Title>` codes. We branch on those rather than on
 * message text, which is not part of any stability contract.
 */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;

  if (error instanceof ConfigurationError) {
    return new AppError("CONFIGURATION", error.message, {
      hint: "Set the NEO4J_* variables in .env.local (see .env.example), then restart the dev server.",
      cause: error,
      retryable: false,
    });
  }

  if (error instanceof Neo4jError) {
    const code = error.code ?? "";

    if (code === "ServiceUnavailable" || code === "SessionExpired") {
      return new AppError(
        "DB_UNAVAILABLE",
        "Could not reach the graph database.",
        {
          hint:
            "Check that your CognoDB instance is running (console.cognodb.com) and that " +
            "NEO4J_URI is correct. Free-tier instances may be paused after inactivity.",
          cause: error,
        },
      );
    }

    if (code.startsWith("Neo.ClientError.Security")) {
      return new AppError("DB_AUTH", "The graph database rejected our credentials.", {
        hint: "Verify NEO4J_USERNAME (CognoDB uses `cognodb`) and NEO4J_PASSWORD in .env.local.",
        cause: error,
        retryable: false,
      });
    }

    if (code === "Neo.ClientError.Database.DatabaseNotFound") {
      return new AppError("CONFIGURATION", "The configured database does not exist.", {
        hint: "Check NEO4J_DATABASE - CognoDB and Neo4j both default to `neo4j`.",
        cause: error,
        retryable: false,
      });
    }

    if (code.startsWith("Neo.TransientError")) {
      return new AppError("DB_UNAVAILABLE", "The graph database is temporarily busy.", {
        hint: "This usually resolves on its own. Try again in a moment.",
        cause: error,
      });
    }

    // A malformed or mistyped Cypher statement is our bug, not the caller's.
    // Surface it as a 500 with a generic message; details go to the server log.
    return new AppError("INTERNAL", "The graph query failed.", {
      hint: "This is a bug in Understory, not in your input.",
      cause: error,
      retryable: false,
    });
  }

  const syscall = systemErrorCode(error);
  if (syscall !== undefined && UNREACHABLE_SYSCALL_CODES.has(syscall)) {
    return new AppError("DB_UNAVAILABLE", "Could not reach the graph database.", {
      hint: `Network error (${syscall}). Check NEO4J_URI and your connection.`,
      cause: error,
    });
  }

  if (error instanceof Error && error.name === "AbortError") {
    return new AppError("DB_TIMEOUT", "The graph query took too long and was cancelled.", {
      hint: "Try narrowing the traversal depth or picking a smaller package.",
      cause: error,
    });
  }

  return new AppError("INTERNAL", "Something went wrong.", { cause: error, retryable: false });
}

/**
 * Server-side logging. Keeps the full chain (including the driver's original
 * message and any Cypher context) out of the response but in the logs, where
 * it belongs.
 */
export function logError(context: string, error: unknown): void {
  const app = toAppError(error);
  const cause = app.cause;
  // eslint-disable-next-line no-console -- server-side diagnostics
  console.error(
    `[understory] ${context} - ${app.code}: ${app.message}`,
    cause instanceof Error ? `\n  caused by: ${cause.name}: ${cause.message}` : "",
  );
}
