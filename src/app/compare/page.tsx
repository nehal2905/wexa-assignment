import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";

import { DatabaseError } from "@/components/database-error";
import { PackagePicker } from "@/components/package-picker";
import { Badge, EmptyState, Panel, PanelSkeleton, QueryFootnote, SectionHeading } from "@/components/ui";
import { toAppError } from "@/lib/db/errors";
import { packageHref } from "@/lib/format";
import { versionKey } from "@/lib/graph/model";
import { getPackageVersions } from "@/lib/queries/discovery";
import { compareFootprints } from "@/lib/queries/compare";

/**
 * Side-by-side dependency footprint comparison.
 *
 * The question behind this page is one every team has had: "we're picking
 * between two libraries — what does each one actually cost us?" The answer is a
 * set operation over two transitive closures, which is the single clearest
 * example in this application of something a relational schema would find
 * genuinely awkward.
 */
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Compare two packages",
  description:
    "What two npm packages share, and what each one drags in on its own — computed over their full transitive dependency closures.",
};

interface PageProps {
  searchParams: Promise<{ left?: string; right?: string }>;
}

export default async function ComparePage({ searchParams }: PageProps) {
  const { left = null, right = null } = await searchParams;

  return (
    <div className="mx-auto max-w-[1100px] px-6 py-10">
      <SectionHeading
        eyebrow="Comparison"
        title="What does each one actually cost you?"
        description="Pick two packages. Understory walks the dependency closure of each — every resolved version that would actually be installed, up to eight hops down — and reports what they have in common and what each one drags in alone. Dev tooling is excluded, because npm never installs a dependency's own devDependencies."
      />

      <div className="surface-card grid gap-4 p-5 sm:grid-cols-2">
        <PackagePicker
          param="left"
          label="First package"
          placeholder="e.g. express"
          selected={left}
        />
        <PackagePicker
          param="right"
          label="Second package"
          placeholder="e.g. koa"
          selected={right}
        />
      </div>

      <div className="mt-5">
        {left === null || right === null ? (
          <div className="surface-card">
            <EmptyState
              icon="⇄"
              title="Choose two packages"
              description="Both sides need a selection before there is anything to compare. Try express against koa, or axios against got."
              action={
                <div className="flex flex-wrap justify-center gap-2">
                  {[
                    ["express", "koa"],
                    ["axios", "got"],
                    ["webpack", "vite"],
                  ].map(([a, b]) => (
                    <Link
                      key={`${a}-${b}`}
                      href={`/compare?left=${a}&right=${b}`}
                      className="rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-surface)] px-3 py-1.5 font-mono text-[12px] text-[var(--color-ink-muted)] transition-colors hover:border-[var(--color-accent-dim)] hover:text-[var(--color-accent)]"
                    >
                      {a} vs {b}
                    </Link>
                  ))}
                </div>
              }
            />
          </div>
        ) : (
          <Suspense
            key={`${left}-${right}`}
            fallback={<PanelSkeleton title="Comparing closures…" rows={6} />}
          >
            <ComparisonResult left={left} right={right} />
          </Suspense>
        )}
      </div>
    </div>
  );
}

async function ComparisonResult({ left, right }: { left: string; right: string }) {
  try {
    // Resolve each name to a concrete version node before comparing — the graph
    // stores versions, not packages, and the answer differs between them.
    const [leftVersions, rightVersions] = await Promise.all([
      getPackageVersions(left),
      getPackageVersions(right),
    ]);

    const leftRecord = leftVersions.rows[0];
    const rightRecord = rightVersions.rows[0];

    const leftVersion = leftRecord?.rootVersion ?? leftRecord?.versions[0];
    const rightVersion = rightRecord?.rootVersion ?? rightRecord?.versions[0];

    if (leftVersion === undefined || rightVersion === undefined) {
      return (
        <div className="surface-card">
          <EmptyState
            icon="○"
            title="One of those isn't in the graph"
            description={`${leftVersion === undefined ? left : right} was not found in this dataset. Understory holds a seeded slice of the registry, not all of npm.`}
          />
        </div>
      );
    }

    const { rows, meta } = await compareFootprints(
      versionKey(left, leftVersion),
      versionKey(right, rightVersion),
    );
    const result = rows[0];

    if (result === undefined) {
      return (
        <div className="surface-card">
          <EmptyState
            icon="○"
            title="Nothing to compare"
            description="Neither package has any dependencies in this graph."
          />
        </div>
      );
    }

    const overlapPercent =
      result.leftTotal + result.rightTotal === 0
        ? 0
        : Math.round(
            (result.shared.length /
              (result.leftTotal + result.rightTotal - result.shared.length)) *
              100,
          );

    return (
      <div className="space-y-5">
        <Panel>
          <div className="grid gap-px bg-[var(--color-line)] sm:grid-cols-3">
            <Summary
              label={`${left}@${leftVersion}`}
              value={result.leftTotal}
              caption="packages in its closure"
            />
            <Summary
              label="shared"
              value={result.shared.length}
              caption={`${overlapPercent}% overlap between the two trees`}
              accent
            />
            <Summary
              label={`${right}@${rightVersion}`}
              value={result.rightTotal}
              caption="packages in its closure"
            />
          </div>
          <QueryFootnote queryId="compare-footprints" serverMs={meta.consumedAfterMs} />
        </Panel>

        <div className="grid gap-5 lg:grid-cols-3">
          <PackageList
            title={`Only ${left}`}
            description="You take these on if you choose it, and not otherwise."
            names={result.onlyLeft}
            tone="left"
          />
          <PackageList
            title="Shared by both"
            description="Already in your tree either way, so not a differentiator."
            names={result.shared}
            tone="shared"
          />
          <PackageList
            title={`Only ${right}`}
            description="You take these on if you choose it, and not otherwise."
            names={result.onlyRight}
            tone="right"
          />
        </div>
      </div>
    );
  } catch (error) {
    return <DatabaseError error={toAppError(error)} />;
  }
}

function Summary({
  label,
  value,
  caption,
  accent = false,
}: {
  label: string;
  value: number;
  caption: string;
  accent?: boolean;
}) {
  return (
    <div className="bg-[var(--color-surface)] px-5 py-5 text-center">
      <p
        className={
          "tabular text-3xl font-semibold tracking-tight " +
          (accent ? "text-[var(--color-accent)]" : "text-[var(--color-ink)]")
        }
      >
        {value}
      </p>
      <p className="mt-1 truncate font-mono text-[12px] text-[var(--color-ink-muted)]">{label}</p>
      <p className="mt-1 text-[11.5px] text-[var(--color-ink-faint)]">{caption}</p>
    </div>
  );
}

function PackageList({
  title,
  description,
  names,
  tone,
}: {
  title: string;
  description: string;
  names: string[];
  tone: "left" | "shared" | "right";
}) {
  return (
    <Panel title={title} description={description}>
      {names.length === 0 ? (
        <p className="px-5 py-8 text-center text-[13px] text-[var(--color-ink-faint)]">
          Nothing here.
        </p>
      ) : (
        <div className="max-h-96 overflow-y-auto px-5 py-4">
          <div className="flex flex-wrap gap-1.5">
            {names.map((name) => (
              <Link key={name} href={packageHref(name)}>
                <Badge
                  className={
                    tone === "shared"
                      ? "border-[color-mix(in_oklab,var(--color-accent)_25%,transparent)] bg-[var(--color-accent-ghost)] text-[var(--color-accent)]"
                      : undefined
                  }
                >
                  {name}
                </Badge>
              </Link>
            ))}
          </div>
        </div>
      )}
      <div className="border-t border-[var(--color-line)] px-5 py-2.5">
        <p className="tabular font-mono text-[11px] text-[var(--color-ink-faint)]">
          {names.length} package{names.length === 1 ? "" : "s"}
        </p>
      </div>
    </Panel>
  );
}
