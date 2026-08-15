/**
 * The graph data model, in one place.
 *
 * +--------------+  MAINTAINS   +-----------+
 * |  Maintainer  |------------->|  Package  |
 * +--------------+              +-----------+
 *         ^                           ^
 *         | PUBLISHED_BY              | VERSION_OF
 *         |                           |
 *    +---------+   DEPENDS_ON    +---------+
 *    | Version |---------------->| Version |   (self-referential: the tree)
 *    +---------+  {range,scope}  +---------+
 *         |                           ^
 *         | LICENSED_UNDER            | AFFECTS {introducedIn, fixedIn}
 *         v                           |
 *    +---------+              +---------------+
 *    | License |              | Vulnerability |
 *    +---------+              +---------------+
 *
 * ## The one modelling decision that matters
 *
 * `DEPENDS_ON` connects **Version -> Version**, not Package -> Package.
 *
 * A package.json records a *range* ("^4.17.0"), but what actually ends up on
 * disk is a single resolved version. If the graph stored Package -> Package
 * edges, then "does my app reach a vulnerable package?" would be unanswerable -
 * vulnerabilities apply to version ranges, so the answer depends entirely on
 * which version each edge resolved to. Modelling concrete versions as first-class
 * nodes and resolving every range at seed time (see `scripts/seed/resolve.ts`) is
 * what makes the reachability queries truthful rather than approximate.
 *
 * The declared range is preserved as a property on the edge, so the UI can still
 * show "express depends on `body-parser@^1.20.0`, resolved to 1.20.3".
 */

/* -------------------------------------------------------------------------- */
/* Node labels                                                                 */
/* -------------------------------------------------------------------------- */

export const NODE_LABELS = [
  "Package",
  "Version",
  "Maintainer",
  "Vulnerability",
  "License",
] as const;

export type NodeLabel = (typeof NODE_LABELS)[number];

/** An npm package identity. One node per package name, regardless of version. */
export interface PackageNode {
  /** Registry name, e.g. `express` or `@babel/core`. Unique. */
  name: string;
  /** Lowercased copy of `name`, indexed to back case-insensitive search. */
  nameLower: string;
  description: string | null;
  repository: string | null;
  homepage: string | null;
  /** Latest published version at seed time. */
  latestVersion: string | null;
  /** Downloads in the last week, from api.npmjs.org. Null when unavailable. */
  weeklyDownloads: number | null;
  /**
   * True for the packages the seed crawl started from - the "applications" a
   * user picks in the UI, as opposed to packages that were only pulled in
   * transitively.
   */
  isRoot: boolean;
}

/** A concrete published version. This is the node the dependency tree is built from. */
export interface VersionNode {
  /** `${name}@${version}`, e.g. `express@4.21.2`. Unique. */
  key: string;
  /** Denormalised for cheap lookups without a hop to :Package. */
  packageName: string;
  version: string;
  publishedAt: string | null;
  /** Deprecation notice from the registry, when the version is deprecated. */
  deprecated: string | null;
  unpackedSize: number | null;
  fileCount: number | null;
}

export interface MaintainerNode {
  /** npm username. Unique. */
  username: string;
  email: string | null;
}

export type Severity = "CRITICAL" | "HIGH" | "MODERATE" | "LOW" | "UNKNOWN";


export interface VulnerabilityNode {
  /** OSV identifier, usually a GHSA id. Unique. */
  id: string;
  /** CVE ids and other identifiers for the same issue. */
  aliases: string[];
  severity: Severity;
  /** CVSS v3 base score when the advisory publishes one. */
  cvssScore: number | null;
  summary: string;
  details: string | null;
  url: string | null;
  published: string | null;
  /** CWE identifiers, e.g. `CWE-79`. */
  cwes: string[];
}

/**
 * How much obligation a license places on a consumer. This is the axis that
 * actually matters when you find one buried at depth 5 of your tree.
 */
export type LicenseCategory =
  | "permissive"
  | "weak-copyleft"
  | "strong-copyleft"
  | "network-copyleft"
  | "proprietary"
  | "unknown";

export interface LicenseNode {
  /** SPDX identifier, e.g. `MIT`, `GPL-3.0-only`. Unique. */
  spdxId: string;
  category: LicenseCategory;
  osiApproved: boolean;
}

/* -------------------------------------------------------------------------- */
/* Relationship types                                                          */
/* -------------------------------------------------------------------------- */

export const RELATIONSHIP_TYPES = [
  "VERSION_OF",
  "DEPENDS_ON",
  "MAINTAINS",
  "PUBLISHED_BY",
  "LICENSED_UNDER",
  "AFFECTS",
] as const;

export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];

/**
 * Dependency scope, mirroring how npm actually installs.
 *
 *  - `prod`     - `dependencies`. Installed transitively, forever. Ships to users.
 *  - `dev`      - `devDependencies`. Installed only for the package being developed,
 *                 never transitively. We therefore record these *only* on root
 *                 packages, which is exactly npm's own semantics.
 *  - `optional` - `optionalDependencies`. Installed transitively but tolerated to fail.
 *  - `peer`     - `peerDependencies`. Recorded for completeness, but not traversed
 *                 by the crawler: peer ranges are deliberately wide and following
 *                 them explodes the graph well past the free tier's budget.
 */
export type DependencyScope = "prod" | "dev" | "optional" | "peer";

/** Scopes that represent code actually shipped to an end user. */
export const SHIPPING_SCOPES: readonly DependencyScope[] = ["prod", "optional"];

export interface DependsOnRelationship {
  /** The semver range as declared in package.json, e.g. `^4.17.0`. */
  range: string;
  scope: DependencyScope;
}

export interface AffectsRelationship {
  /** First version known to be affected, per the advisory. */
  introducedIn: string | null;
  /** First version containing the fix, or null if unpatched. */
  fixedIn: string | null;
}

/* -------------------------------------------------------------------------- */
/* Helpers shared by the seed pipeline and the app                             */
/* -------------------------------------------------------------------------- */

export function versionKey(packageName: string, version: string): string {
  return `${packageName}@${version}`;
}

export function parseVersionKey(
  key: string,
): { packageName: string; version: string } | null {
  // Scoped packages contain a leading `@`, so split on the *last* `@`.
  const at = key.lastIndexOf("@");
  if (at <= 0) return null;
  const packageName = key.slice(0, at);
  const version = key.slice(at + 1);
  if (packageName === "" || version === "") return null;
  return { packageName, version };
}

/**
 * Maps an SPDX identifier to its obligation category.
 *
 * Prefix matching is intentional: SPDX has many variants of the same family
 * (`GPL-3.0`, `GPL-3.0-only`, `GPL-3.0-or-later`) and they carry the same
 * obligations for this purpose.
 */
export function categoriseLicense(spdxId: string): LicenseCategory {
  const id = spdxId.trim().toUpperCase();
  if (id === "" || id === "UNKNOWN" || id === "UNLICENSED" || id === "SEE LICENSE IN") {
    return id === "UNLICENSED" ? "proprietary" : "unknown";
  }
  if (id.startsWith("AGPL")) return "network-copyleft";
  if (id.startsWith("GPL")) return "strong-copyleft";
  if (id.startsWith("LGPL") || id.startsWith("MPL") || id.startsWith("EPL") || id.startsWith("CDDL")) {
    return "weak-copyleft";
  }
  if (
    id.startsWith("MIT") ||
    id.startsWith("ISC") ||
    id.startsWith("BSD") ||
    id.startsWith("APACHE") ||
    id.startsWith("0BSD") ||
    id.startsWith("UNLICENSE") ||
    id.startsWith("CC0") ||
    id.startsWith("PYTHON") ||
    id.startsWith("ZLIB") ||
    id.startsWith("WTFPL") ||
    id.startsWith("BLUEOAK") ||
    id.startsWith("ARTISTIC")
  ) {
    return "permissive";
  }
  return "unknown";
}

const OSI_APPROVED_PREFIXES = [
  "MIT",
  "ISC",
  "BSD",
  "APACHE",
  "GPL",
  "LGPL",
  "AGPL",
  "MPL",
  "EPL",
  "CDDL",
  "ARTISTIC",
  "ZLIB",
  "PYTHON",
];

export function isOsiApproved(spdxId: string): boolean {
  const id = spdxId.trim().toUpperCase();
  return OSI_APPROVED_PREFIXES.some((prefix) => id.startsWith(prefix));
}

/** Normalises OSV's severity vocabulary onto ours. */
export function normaliseSeverity(raw: string | null | undefined): Severity {
  switch ((raw ?? "").toUpperCase()) {
    case "CRITICAL":
      return "CRITICAL";
    case "HIGH":
      return "HIGH";
    case "MODERATE":
    case "MEDIUM":
      return "MODERATE";
    case "LOW":
      return "LOW";
    default:
      return "UNKNOWN";
  }
}

/** Derives a severity band from a CVSS v3 base score, per the CVSS spec. */
export function severityFromCvss(score: number | null): Severity {
  if (score === null || Number.isNaN(score)) return "UNKNOWN";
  if (score >= 9.0) return "CRITICAL";
  if (score >= 7.0) return "HIGH";
  if (score >= 4.0) return "MODERATE";
  if (score > 0) return "LOW";
  return "UNKNOWN";
}
