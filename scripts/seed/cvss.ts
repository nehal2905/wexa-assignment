/**
 * CVSS v3.x base score, computed from the vector string.
 *
 * ## Why compute rather than read
 *
 * OSV advisories publish a CVSS *vector* (`CVSS:3.1/AV:N/AC:L/...`) but not the
 * numeric base score. GitHub advisories separately publish a coarse severity
 * band ("HIGH", "MODERATE"), which is enough to colour a badge but not enough to
 * rank two HIGH findings against each other - and ranking is exactly what the
 * "which upgrade removes the most risk" view needs.
 *
 * The base score formula is fully specified and deterministic (CVSS v3.1
 * specification, section 7.1), so it is implemented here rather than pulled in
 * as a dependency. It is about forty lines and has no runtime inputs beyond the
 * vector itself.
 *
 * v4.0 vectors are *not* scored: v4 replaces the closed-form equation with a
 * large interpolation table, which is not worth vendoring for the handful of
 * advisories that currently carry one. Those fall back to the advisory's
 * published severity band - see `normaliseSeverity` in the graph model.
 */

const ATTACK_VECTOR: Record<string, number> = { N: 0.85, A: 0.62, L: 0.55, P: 0.2 };
const ATTACK_COMPLEXITY: Record<string, number> = { L: 0.77, H: 0.44 };
const USER_INTERACTION: Record<string, number> = { N: 0.85, R: 0.62 };
const CIA_IMPACT: Record<string, number> = { H: 0.56, L: 0.22, N: 0 };

/**
 * Privileges Required is the one metric whose weight depends on another metric:
 * when Scope is Changed, holding privileges on the vulnerable component grants
 * less protection, so the weights rise.
 */
const PRIVILEGES_REQUIRED: Record<"U" | "C", Record<string, number>> = {
  U: { N: 0.85, L: 0.62, H: 0.27 },
  C: { N: 0.85, L: 0.68, H: 0.5 },
};

/**
 * CVSS-specific rounding: always round *up* to one decimal place.
 *
 * The integer arithmetic is prescribed by the specification, not incidental -
 * a plain `Math.ceil(x * 10) / 10` disagrees with the reference implementation
 * on values that are exactly representable only after the x100000 scaling,
 * producing scores that are off by 0.1 from every published score.
 */
function roundUp(input: number): number {
  const scaled = Math.round(input * 100_000);
  if (scaled % 10_000 === 0) return scaled / 100_000;
  return (Math.floor(scaled / 10_000) + 1) / 10;
}

function parseVector(vector: string): Map<string, string> {
  const metrics = new Map<string, string>();
  for (const part of vector.split("/")) {
    const separator = part.indexOf(":");
    if (separator === -1) continue;
    metrics.set(part.slice(0, separator).toUpperCase(), part.slice(separator + 1).toUpperCase());
  }
  return metrics;
}

/**
 * Returns the CVSS v3.x base score for a vector string, or null if the vector is
 * not v3.x or is missing a required metric.
 */
export function cvssV3BaseScore(vector: string): number | null {
  const trimmed = vector.trim();
  if (!/^CVSS:3\.[01]\//i.test(trimmed)) return null;

  const metrics = parseVector(trimmed);

  const scope = metrics.get("S");
  if (scope !== "U" && scope !== "C") return null;

  const av = ATTACK_VECTOR[metrics.get("AV") ?? ""];
  const ac = ATTACK_COMPLEXITY[metrics.get("AC") ?? ""];
  const pr = PRIVILEGES_REQUIRED[scope][metrics.get("PR") ?? ""];
  const ui = USER_INTERACTION[metrics.get("UI") ?? ""];
  const c = CIA_IMPACT[metrics.get("C") ?? ""];
  const i = CIA_IMPACT[metrics.get("I") ?? ""];
  const a = CIA_IMPACT[metrics.get("A") ?? ""];

  if ([av, ac, pr, ui, c, i, a].some((value) => value === undefined)) return null;

  const iss = 1 - (1 - c!) * (1 - i!) * (1 - a!);

  const impact =
    scope === "U"
      ? 6.42 * iss
      : 7.52 * (iss - 0.029) - 3.25 * Math.pow(iss - 0.02, 15);

  if (impact <= 0) return 0;

  const exploitability = 8.22 * av! * ac! * pr! * ui!;

  const raw =
    scope === "U"
      ? Math.min(impact + exploitability, 10)
      : Math.min(1.08 * (impact + exploitability), 10);

  return roundUp(raw);
}

/**
 * Picks the best score available from an OSV `severity` array, which may carry
 * several entries of different CVSS versions.
 */
export function bestCvssScore(
  severities: ReadonlyArray<{ type?: string; score?: string }> | undefined,
): number | null {
  if (severities === undefined) return null;
  for (const entry of severities) {
    if (typeof entry.score !== "string") continue;
    const score = cvssV3BaseScore(entry.score);
    if (score !== null) return score;
  }
  return null;
}
