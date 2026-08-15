import path from "node:path";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * Pin the workspace root to this directory.
   *
   * Next.js infers the root by walking up looking for lockfiles, and an
   * unrelated `package-lock.json` further up the tree makes it pick the wrong
   * one. That changes which files get traced into the deployment bundle, so
   * pinning it removes a genuinely confusing class of "works locally, missing
   * files in production" failure.
   */
  outputFileTracingRoot: path.join(__dirname),

  /**
   * `neo4j-driver` opens raw TCP/TLS sockets, so every module that touches it
   * must run in the Node.js runtime rather than the Edge runtime. Route handlers
   * declare `export const runtime = "nodejs"` individually; this keeps the
   * bundler from trying to trace the driver into the client bundle as well.
   */
  serverExternalPackages: ["neo4j-driver"],

  eslint: {
    // Type errors still fail the build via `tsc --noEmit` in CI; we don't want a
    // missing eslint config to block a deploy.
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
