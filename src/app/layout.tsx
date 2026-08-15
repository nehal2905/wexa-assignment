import type { Metadata, Viewport } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import "./globals.css";
import { NavLinks } from "@/components/nav-links";

export const metadata: Metadata = {
  title: {
    default: "Understory - the dependency graph beneath your package.json",
    template: "%s | Understory",
  },
  description:
    "Explore the transitive dependency graph of any npm package: which vulnerabilities it can actually reach and through what chain, which maintainers control the most of your tree, and which single upgrade removes the most risk. Built on CognoDB.",
  applicationName: "Understory",
  openGraph: {
    title: "Understory",
    description:
      "The dependency graph beneath your package.json - vulnerability reachability, maintainer blast radius, and license exposure.",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#08090b",
  colorScheme: "dark",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        {/* Keyboard users should be able to jump the navigation on every page. */}
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:bg-[var(--color-accent)] focus:px-4 focus:py-2 focus:text-[13px] focus:font-semibold focus:text-[#04110c]"
        >
          Skip to content
        </a>

        <div className="flex min-h-screen flex-col">
          <SiteHeader />
          <main id="main" className="flex-1">
            {children}
          </main>
          <SiteFooter />
        </div>
      </body>
    </html>
  );
}

function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-[var(--color-line)] bg-[var(--color-ground)]/85 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-[1400px] items-center gap-6 px-6">
        <Link href="/" className="group flex shrink-0 items-center gap-2.5">
          <UnderstoryMark />
          <span className="text-[15px] font-semibold tracking-tight">Understory</span>
        </Link>
        <NavLinks />
      </div>
    </header>
  );
}

/**
 * The logo is an inline SVG rather than an image file: it is a dozen elements,
 * it inherits `currentColor`, and it costs no extra request.
 *
 * The shape is the idea - a canopy line with the branching structure hanging
 * below it, which is what the application shows you.
 */
function UnderstoryMark() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      aria-hidden
      className="text-[var(--color-accent)]"
    >
      <path d="M2.5 4.5h15" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path
        d="M10 4.5v3.5M10 8h-4v3M10 8h4v3M6 11v3M14 11v3"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeOpacity="0.75"
      />
      <circle cx="6" cy="15" r="1.5" fill="currentColor" />
      <circle cx="14" cy="15" r="1.5" fill="currentColor" fillOpacity="0.55" />
    </svg>
  );
}

function SiteFooter() {
  return (
    <footer className="mt-16 border-t border-[var(--color-line)]">
      <div className="mx-auto flex max-w-[1400px] flex-col gap-3 px-6 py-7 text-[12.5px] text-[var(--color-ink-faint)] sm:flex-row sm:items-center sm:justify-between">
        <p className="leading-relaxed">
          Dependency data from the{" "}
          <a
            className="underline decoration-[var(--color-line-strong)] underline-offset-4 hover:text-[var(--color-ink-muted)]"
            href="https://registry.npmjs.org"
            target="_blank"
            rel="noreferrer"
          >
            npm registry
          </a>
          , advisories from{" "}
          <a
            className="underline decoration-[var(--color-line-strong)] underline-offset-4 hover:text-[var(--color-ink-muted)]"
            href="https://osv.dev"
            target="_blank"
            rel="noreferrer"
          >
            OSV.dev
          </a>
          . Stored as a graph in CognoDB.
        </p>
        <p className="shrink-0">
          A point-in-time snapshot - not a substitute for{" "}
          <span className="font-mono text-[11.5px]">npm audit</span>.
        </p>
      </div>
    </footer>
  );
}
