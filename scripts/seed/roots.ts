/**
 * The packages the crawl starts from.
 *
 * These become the "applications" a user picks in the UI; everything else in the
 * graph arrives transitively. Two deliberate choices:
 *
 *  1. **Breadth over depth.** The list spans web frameworks, build tooling, HTTP
 *     clients, auth, databases and test runners, so the graph contains genuinely
 *     distinct neighbourhoods rather than one dense React blob. That makes the
 *     "what do these two packages share?" comparison meaningful.
 *
 *  2. **Some roots are pinned to older versions, on purpose.** If every root
 *     resolved to `latest`, the vulnerability views would mostly render empty -
 *     maintainers do their job, and the current release of a popular package
 *     usually has a clean tree. Pinning a handful to versions people really are
 *     still running (the `express@4.17.1` in a 2019 Dockerfile, the
 *     `axios@0.21.0` in an unmaintained internal service) is what an actual
 *     audit looks like, and it exercises the reachability queries with real
 *     advisories rather than synthetic ones.
 *
 * Pinned entries are marked in the UI so nobody mistakes them for a claim about
 * the current release.
 */

export interface RootPackage {
  name: string;
  /** Exact version to pin to, or `undefined` to resolve `latest` at seed time. */
  version?: string;
  category: RootCategory;
  /** One line shown in the package picker. */
  blurb: string;
  /** Why this version was pinned, shown as a caveat in the UI. */
  pinnedBecause?: string;
}

export type RootCategory =
  | "Web frameworks"
  | "Frontend"
  | "Build tooling"
  | "HTTP clients"
  | "Auth & security"
  | "Databases"
  | "Testing"
  | "Utilities";

export const ROOT_PACKAGES: readonly RootPackage[] = [
  /* --- Web frameworks ---------------------------------------------------- */
  {
    name: "express",
    version: "4.17.1",
    category: "Web frameworks",
    blurb: "The default Node.js web framework.",
    pinnedBecause: "A very common 'we'll upgrade it later' version, still widely deployed.",
  },
  { name: "fastify", category: "Web frameworks", blurb: "Low-overhead Node.js web framework." },
  { name: "koa", category: "Web frameworks", blurb: "Minimalist framework from the Express team." },
  { name: "@nestjs/core", category: "Web frameworks", blurb: "Opinionated TypeScript server framework." },

  /* --- Frontend ---------------------------------------------------------- */
  { name: "react-dom", category: "Frontend", blurb: "React's renderer for the web." },
  { name: "vue", category: "Frontend", blurb: "Progressive frontend framework." },
  { name: "svelte", category: "Frontend", blurb: "Compiler-first UI framework." },
  { name: "styled-components", category: "Frontend", blurb: "CSS-in-JS styling for React." },

  /* --- Build tooling ----------------------------------------------------- */
  { name: "vite", category: "Build tooling", blurb: "Modern frontend build tool." },
  { name: "webpack", category: "Build tooling", blurb: "The long-standing JavaScript bundler." },
  { name: "@babel/core", category: "Build tooling", blurb: "JavaScript compiler toolchain." },
  {
    name: "gulp",
    version: "3.9.1",
    category: "Build tooling",
    blurb: "Streaming build system.",
    pinnedBecause: "The last 3.x release - abandoned in 2018 and still present in many legacy repos.",
  },

  /* --- HTTP clients ------------------------------------------------------ */
  {
    name: "axios",
    version: "0.21.0",
    category: "HTTP clients",
    blurb: "Promise-based HTTP client.",
    pinnedBecause: "Predates the 0.21.1 SSRF fix - a well-documented real-world advisory.",
  },
  {
    name: "request",
    version: "2.88.2",
    category: "HTTP clients",
    blurb: "Formerly ubiquitous HTTP client, now deprecated.",
    pinnedBecause: "Final release. Officially deprecated in 2020 but still pulled in transitively everywhere.",
  },
  { name: "got", category: "HTTP clients", blurb: "Human-friendly HTTP request library." },
  { name: "node-fetch", version: "2.6.0", category: "HTTP clients", blurb: "fetch() for Node.js.", pinnedBecause: "Predates the 2.6.1 information-disclosure fix." },

  /* --- Auth & security --------------------------------------------------- */
  {
    name: "jsonwebtoken",
    version: "8.5.1",
    category: "Auth & security",
    blurb: "JSON Web Token signing and verification.",
    pinnedBecause: "The 8.x line carries several 2022 advisories fixed only in 9.0.0.",
  },
  { name: "passport", category: "Auth & security", blurb: "Authentication middleware for Node.js." },
  { name: "helmet", category: "Auth & security", blurb: "Security headers middleware." },

  /* --- Databases --------------------------------------------------------- */
  { name: "mongoose", category: "Databases", blurb: "MongoDB object modelling." },
  { name: "sequelize", category: "Databases", blurb: "SQL ORM for Node.js." },
  { name: "pg", category: "Databases", blurb: "PostgreSQL client." },

  /* --- Testing ----------------------------------------------------------- */
  { name: "jest", category: "Testing", blurb: "JavaScript testing framework." },
  { name: "mocha", category: "Testing", blurb: "Flexible test runner." },
  { name: "cypress", category: "Testing", blurb: "End-to-end browser testing." },

  /* --- Utilities --------------------------------------------------------- */
  {
    name: "lodash",
    version: "4.17.15",
    category: "Utilities",
    blurb: "Utility belt for JavaScript.",
    pinnedBecause: "Predates the 4.17.21 prototype-pollution and ReDoS fixes.",
  },
  { name: "moment", version: "2.24.0", category: "Utilities", blurb: "Date handling (now in maintenance mode).", pinnedBecause: "Predates the 2.29.4 ReDoS fix." },
  { name: "socket.io", version: "2.3.0", category: "Utilities", blurb: "Realtime bidirectional events." },
  { name: "eslint", category: "Utilities", blurb: "Pluggable JavaScript linter." },
  { name: "nodemailer", category: "Utilities", blurb: "Email sending for Node.js." },
  { name: "sharp", category: "Utilities", blurb: "High-performance image processing." },
];

export const ROOT_CATEGORIES: readonly RootCategory[] = [
  "Web frameworks",
  "Frontend",
  "Build tooling",
  "HTTP clients",
  "Auth & security",
  "Databases",
  "Testing",
  "Utilities",
];
