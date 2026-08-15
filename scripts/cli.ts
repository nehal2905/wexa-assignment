/**
 * Small terminal helpers shared by the CLI scripts.
 *
 * Colour is applied only when stdout is a TTY and `NO_COLOR` is unset, so piping
 * output to a file or a CI log produces clean text rather than escape codes.
 * The ESC byte is built with `String.fromCharCode(27)` rather than embedded as a
 * literal control character, so the source stays diffable and renders correctly
 * in editors and on GitHub.
 */

const useColour = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;

const ESC = String.fromCharCode(27);
const RESET = `${ESC}[0m`;

const wrap =
  (code: string) =>
  (text: string): string =>
    useColour ? `${ESC}[${code}m${text}${RESET}` : text;

export const style = {
  bold: wrap("1"),
  dim: wrap("2"),
  red: wrap("31"),
  green: wrap("32"),
  yellow: wrap("33"),
  blue: wrap("34"),
  cyan: wrap("36"),
};

export function heading(text: string): void {
  process.stdout.write(`\n${style.bold(text)}\n`);
}

export function step(text: string): void {
  process.stdout.write(`  ${style.dim(">")} ${text}\n`);
}

export function ok(text: string): void {
  process.stdout.write(`  ${style.green("+")} ${text}\n`);
}

export function warn(text: string): void {
  process.stdout.write(`  ${style.yellow("!")} ${text}\n`);
}

export function fail(text: string): void {
  process.stderr.write(`  ${style.red("x")} ${text}\n`);
}

/** Overwrites the current line - used for progress that would otherwise scroll. */
export function progress(text: string): void {
  if (!useColour) return;
  process.stdout.write(`\r  ${style.dim(">")} ${text}${ESC}[K`);
}

export function endProgress(): void {
  if (useColour) process.stdout.write(`\r${ESC}[K`);
}

export function table(rows: ReadonlyArray<readonly [string, string | number]>): void {
  if (rows.length === 0) return;
  const width = Math.max(...rows.map(([label]) => label.length));
  for (const [label, value] of rows) {
    process.stdout.write(`  ${style.dim(label.padEnd(width))}  ${String(value)}\n`);
  }
}

export function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} m ${Math.round(seconds % 60)} s`;
}

/**
 * Prints a failure in the same shape everywhere and exits non-zero.
 *
 * CLI scripts share this so a misconfigured environment produces the same
 * actionable message whether you ran `db:check`, `db:schema`, or `db:seed`.
 */
export function reportFatal(context: string, error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`\n${style.red("x")} ${style.bold(context)}\n\n  ${message}\n`);

  const hint = (error as { hint?: unknown }).hint;
  if (typeof hint === "string") {
    process.stderr.write(`\n  ${style.dim(hint)}\n`);
  }
  process.stderr.write("\n");
  process.exit(1);
}
