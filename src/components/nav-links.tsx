"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * Primary navigation.
 *
 * A client component solely because it needs `usePathname` to mark the active
 * route - the rest of the header stays on the server.
 */
const LINKS = [
  { href: "/", label: "Explore", exact: true },
  { href: "/compare", label: "Compare" },
  { href: "/connect", label: "Trace a path" },
  { href: "/queries", label: "How it works" },
] as const;

export function NavLinks() {
  const pathname = usePathname();

  return (
    <nav aria-label="Primary" className="flex min-w-0 items-center gap-1 overflow-x-auto">
      {LINKS.map((link) => {
        const isActive =
          "exact" in link && link.exact
            ? pathname === link.href
            : pathname === link.href || pathname.startsWith(`${link.href}/`);

        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={isActive ? "page" : undefined}
            className={
              "shrink-0 rounded-lg px-3 py-1.5 text-[13.5px] font-medium transition-colors " +
              (isActive
                ? "bg-[var(--color-surface-raised)] text-[var(--color-ink)]"
                : "text-[var(--color-ink-muted)] hover:bg-[var(--color-surface)] hover:text-[var(--color-ink)]")
            }
          >
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
