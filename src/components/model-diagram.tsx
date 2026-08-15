/**
 * The graph data model, drawn as inline SVG.
 *
 * Inline rather than an exported image because it has to stay correct: it lives
 * beside the model it documents, uses the same design tokens as the rest of the
 * interface, and renders crisply at any zoom. An image would be one more thing
 * to remember to regenerate when the model changes.
 */
export function GraphModelDiagram() {
  return (
    <svg
      viewBox="0 0 860 420"
      className="h-auto w-full min-w-[720px]"
      role="img"
      aria-label="Graph data model: Maintainer maintains Package; Version is a version of Package; Version depends on Version; Version is licensed under License; Vulnerability affects Version; Version published by Maintainer."
    >
      <defs>
        <marker
          id="model-arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--color-line-strong)" />
        </marker>
        <marker
          id="model-arrow-accent"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--color-accent)" />
        </marker>
      </defs>

      {/* --- Edges (drawn first so nodes sit on top) ---------------------- */}

      {/* Maintainer -> Package */}
      <Edge x1={168} y1={92} x2={352} y2={92} label="MAINTAINS" />

      {/* Version -> Package */}
      <Edge x1={430} y1={210} x2={430} y2={126} label="VERSION_OF" labelDx={54} />

      {/* Version -> Maintainer (published by) */}
      <Edge x1={352} y1={236} x2={168} y2={122} label="PUBLISHED_BY" labelDy={-8} />

      {/* Version -> License */}
      <Edge x1={352} y1={262} x2={186} y2={330} label="LICENSED_UNDER" labelDy={20} />

      {/* Vulnerability -> Version */}
      <Edge x1={676} y1={330} x2={510} y2={268} label="AFFECTS" labelDy={20} />

      {/* Version -> Version, the self-referential dependency edge */}
      <path
        d="M 512 232 C 590 210, 596 268, 516 254"
        fill="none"
        stroke="var(--color-accent)"
        strokeWidth="1.6"
        markerEnd="url(#model-arrow-accent)"
      />
      <text
        x={600}
        y={230}
        className="fill-[var(--color-accent)] font-mono text-[11px]"
        textAnchor="start"
      >
        DEPENDS_ON
      </text>
      <text
        x={600}
        y={245}
        className="fill-[var(--color-ink-faint)] font-mono text-[10px]"
        textAnchor="start"
      >
        {"{ range, scope }"}
      </text>

      {/* --- Nodes -------------------------------------------------------- */}

      <Node
        x={40}
        y={68}
        width={128}
        label="Maintainer"
        fields={["username *", "email"]}
      />

      <Node
        x={352}
        y={56}
        width={156}
        label="Package"
        fields={["name *", "description", "weeklyDownloads", "isRoot"]}
      />

      <Node
        x={352}
        y={210}
        width={160}
        label="Version"
        accent
        fields={["key *", "version", "publishedAt", "deprecated"]}
      />

      <Node
        x={58}
        y={306}
        width={128}
        label="License"
        fields={["spdxId *", "category"]}
      />

      <Node
        x={676}
        y={306}
        width={156}
        label="Vulnerability"
        fields={["id *", "severity", "cvssScore", "summary"]}
      />

      {/* --- Key ---------------------------------------------------------- */}

      <text x={40} y={402} className="fill-[var(--color-ink-faint)] font-mono text-[10.5px]">
        * uniqueness constraint | the accented node and edge carry the resolved dependency tree
      </text>
    </svg>
  );
}

function Node({
  x,
  y,
  width,
  label,
  fields,
  accent = false,
}: {
  x: number;
  y: number;
  width: number;
  label: string;
  fields: string[];
  accent?: boolean;
}) {
  const headerHeight = 26;
  const rowHeight = 15;
  const height = headerHeight + fields.length * rowHeight + 8;

  return (
    <g>
      <rect
        x={x}
        y={y}
        width={width}
        height={height}
        rx={8}
        fill="var(--color-surface-raised)"
        stroke={accent ? "var(--color-accent-dim)" : "var(--color-line-strong)"}
        strokeWidth={accent ? 1.5 : 1}
      />
      <rect
        x={x}
        y={y}
        width={width}
        height={headerHeight}
        rx={8}
        fill={accent ? "var(--color-accent-ghost)" : "var(--color-surface-hover)"}
      />
      {/* Square off the bottom corners of the header band. */}
      <rect
        x={x}
        y={y + headerHeight - 8}
        width={width}
        height={8}
        fill={accent ? "var(--color-accent-ghost)" : "var(--color-surface-hover)"}
      />
      <line
        x1={x}
        y1={y + headerHeight}
        x2={x + width}
        y2={y + headerHeight}
        stroke={accent ? "var(--color-accent-dim)" : "var(--color-line-strong)"}
      />

      <text
        x={x + 10}
        y={y + 17}
        className={
          accent
            ? "fill-[var(--color-accent)] font-mono text-[12px] font-semibold"
            : "fill-[var(--color-ink)] font-mono text-[12px] font-semibold"
        }
      >
        :{label}
      </text>

      {fields.map((field, index) => (
        <text
          key={field}
          x={x + 10}
          y={y + headerHeight + 13 + index * rowHeight}
          className="fill-[var(--color-ink-faint)] font-mono text-[10.5px]"
        >
          {field}
        </text>
      ))}
    </g>
  );
}

function Edge({
  x1,
  y1,
  x2,
  y2,
  label,
  labelDx = 0,
  labelDy = -6,
}: {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  label: string;
  labelDx?: number;
  labelDy?: number;
}) {
  return (
    <g>
      <line
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        stroke="var(--color-line-strong)"
        strokeWidth="1.3"
        markerEnd="url(#model-arrow)"
      />
      <text
        x={(x1 + x2) / 2 + labelDx}
        y={(y1 + y2) / 2 + labelDy}
        textAnchor="middle"
        className="fill-[var(--color-ink-muted)] font-mono text-[10.5px]"
      >
        {label}
      </text>
    </g>
  );
}
