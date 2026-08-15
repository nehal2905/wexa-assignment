import type { LicenseCategory, Severity } from "@/lib/graph/model";

/**
 * Presentation helpers shared across components.
 *
 * Kept out of the components themselves so that the same number renders the same
 * way in every panel — a download count formatted three different ways across
 * one page is the sort of thing that quietly makes an interface feel unfinished.
 */

/** 1_234_567 → "1.2M". Keeps dense tables readable. */
export function compactNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (value < 1000) return String(value);
  if (value < 1_000_000) {
    const thousands = value / 1000;
    return `${thousands < 10 ? thousands.toFixed(1) : Math.round(thousands)}K`;
  }
  if (value < 1_000_000_000) {
    const millions = value / 1_000_000;
    return `${millions < 10 ? millions.toFixed(1) : Math.round(millions)}M`;
  }
  return `${(value / 1_000_000_000).toFixed(1)}B`;
}

export function exactNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return value.toLocaleString("en-US");
}

export function fileSize(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** ISO timestamp → "Mar 2019". Precision beyond the month is noise here. */
export function monthYear(iso: string | null | undefined): string {
  if (iso === null || iso === undefined) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

export function yearsAgo(iso: string | null | undefined): string | null {
  if (iso === null || iso === undefined) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const years = (Date.now() - date.getTime()) / (365.25 * 24 * 60 * 60 * 1000);
  if (years < 1) return "under a year old";
  return `${Math.floor(years)} year${Math.floor(years) === 1 ? "" : "s"} old`;
}

/* -------------------------------------------------------------------------- */
/* Severity                                                                    */
/* -------------------------------------------------------------------------- */

export const SEVERITY_LABEL: Record<Severity, string> = {
  CRITICAL: "Critical",
  HIGH: "High",
  MODERATE: "Moderate",
  LOW: "Low",
  UNKNOWN: "Unrated",
};

/**
 * Tailwind classes per severity.
 *
 * Returned as complete class strings rather than composed from a colour name,
 * because Tailwind's compiler only keeps classes it can see written out in full.
 * A dynamically assembled `text-${severity}` would be stripped from the bundle
 * and the badge would render unstyled in production but fine in development —
 * a genuinely nasty class of bug.
 */
export const SEVERITY_CLASSES: Record<Severity, string> = {
  CRITICAL: "text-[var(--color-critical)] bg-[var(--color-critical-ghost)] border-[color-mix(in_oklab,var(--color-critical)_35%,transparent)]",
  HIGH: "text-[var(--color-high)] bg-[var(--color-high-ghost)] border-[color-mix(in_oklab,var(--color-high)_35%,transparent)]",
  MODERATE: "text-[var(--color-moderate)] bg-[var(--color-moderate-ghost)] border-[color-mix(in_oklab,var(--color-moderate)_32%,transparent)]",
  LOW: "text-[var(--color-low)] bg-[var(--color-low-ghost)] border-[color-mix(in_oklab,var(--color-low)_32%,transparent)]",
  UNKNOWN: "text-[var(--color-unknown)] bg-[var(--color-unknown-ghost)] border-[var(--color-line-strong)]",
};

/** Raw hex per severity, for canvas rendering where CSS classes do not apply. */
export const SEVERITY_HEX: Record<Severity, string> = {
  CRITICAL: "#ff5c5c",
  HIGH: "#ff9f43",
  MODERATE: "#ffd166",
  LOW: "#6fb6ff",
  UNKNOWN: "#8b95a1",
};

const SEVERITY_RANK: Record<Severity, number> = {
  CRITICAL: 4,
  HIGH: 3,
  MODERATE: 2,
  LOW: 1,
  UNKNOWN: 0,
};

/** The most serious severity in a list — what a summary badge should show. */
export function worstSeverity(severities: readonly Severity[]): Severity | null {
  if (severities.length === 0) return null;
  return severities.reduce((worst, current) =>
    SEVERITY_RANK[current] > SEVERITY_RANK[worst] ? current : worst,
  );
}

/* -------------------------------------------------------------------------- */
/* Licences                                                                    */
/* -------------------------------------------------------------------------- */

export const LICENSE_LABEL: Record<LicenseCategory, string> = {
  permissive: "Permissive",
  "weak-copyleft": "Weak copyleft",
  "strong-copyleft": "Strong copyleft",
  "network-copyleft": "Network copyleft",
  proprietary: "Proprietary",
  unknown: "Undeclared",
};

export const LICENSE_NOTE: Record<LicenseCategory, string> = {
  permissive: "Use freely; keep the copyright notice.",
  "weak-copyleft": "Changes to the library itself must be published.",
  "strong-copyleft": "Distributing your work may require publishing its source.",
  "network-copyleft": "Even offering it over a network can trigger the source obligation.",
  proprietary: "No open-source grant. Check the terms before shipping.",
  unknown: "No license declared, which means no permission is granted by default.",
};

export const LICENSE_CLASSES: Record<LicenseCategory, string> = {
  permissive: "text-[var(--color-permissive)] bg-[var(--color-accent-ghost)] border-[color-mix(in_oklab,var(--color-permissive)_30%,transparent)]",
  "weak-copyleft": "text-[var(--color-copyleft)] bg-[var(--color-high-ghost)] border-[color-mix(in_oklab,var(--color-copyleft)_30%,transparent)]",
  "strong-copyleft": "text-[var(--color-copyleft-strong)] bg-[var(--color-critical-ghost)] border-[color-mix(in_oklab,var(--color-copyleft-strong)_30%,transparent)]",
  "network-copyleft": "text-[var(--color-copyleft-strong)] bg-[var(--color-critical-ghost)] border-[color-mix(in_oklab,var(--color-copyleft-strong)_40%,transparent)]",
  proprietary: "text-[var(--color-unknown)] bg-[var(--color-unknown-ghost)] border-[var(--color-line-strong)]",
  unknown: "text-[var(--color-unknown)] bg-[var(--color-unknown-ghost)] border-[var(--color-line-strong)]",
};

/* -------------------------------------------------------------------------- */
/* Dependency scope                                                            */
/* -------------------------------------------------------------------------- */

export const SCOPE_LABEL: Record<string, string> = {
  prod: "runtime",
  dev: "dev only",
  optional: "optional",
  peer: "peer",
};

/** True when any hop in a path is a devDependency edge. */
export function isDevOnlyPath(scopes: readonly string[]): boolean {
  return scopes.includes("dev");
}

/* -------------------------------------------------------------------------- */
/* Version keys                                                                */
/* -------------------------------------------------------------------------- */

/** `express@4.17.1` → URL-safe path segment, preserving scoped names. */
export function packageHref(name: string, version?: string | null): string {
  const base = `/package/${encodeURIComponent(name)}`;
  return version === null || version === undefined ? base : `${base}?version=${encodeURIComponent(version)}`;
}
