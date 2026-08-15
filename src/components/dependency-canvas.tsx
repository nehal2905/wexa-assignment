"use client";

import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from "d3-force";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { SEVERITY_HEX, packageHref, worstSeverity } from "@/lib/format";
import type { Severity } from "@/lib/graph/model";
import type { GraphEdge, GraphNode } from "@/lib/queries/tree";

/**
 * Force-directed dependency graph, rendered to a 2D canvas.
 *
 * ## Why canvas, and why hand-rolled
 *
 * At four hundred nodes and a thousand edges, SVG means fourteen hundred DOM
 * elements that the browser must lay out and composite on every simulation tick.
 * Canvas draws the same frame as a flat list of primitives and stays smooth.
 *
 * The layout comes from `d3-force`, which is the part genuinely worth a
 * dependency - a well-tuned velocity Verlet integrator is not something to
 * reimplement. Everything above it (rendering, hit-testing, zoom, pan, hover) is
 * about a hundred and fifty lines here, versus pulling in a graph-rendering
 * library whose abstractions would have to be worked around to get the severity
 * colouring and depth-based layout this view needs.
 *
 * ## Physics choices
 *
 * The `forceX` pass is what makes this readable. Without it a dependency graph
 * relaxes into an undifferentiated hairball; pinning each node toward a column
 * determined by its depth from the root turns it into something with a reading
 * direction - your package on the left, the things it drags in receding to the
 * right.
 */

interface SimNode extends SimulationNodeDatum, GraphNode {
  /** Cached per-node radius so it is not recomputed on every frame. */
  radius: number;
  worst: Severity | null;
}

type SimLink = SimulationLinkDatum<SimNode> & { scope: string; range: string };

const NODE_BASE_RADIUS = 4.5;
const ROOT_RADIUS = 9;

export function DependencyCanvas({
  nodes: inputNodes,
  edges: inputEdges,
  rootKey,
  height = 560,
}: {
  nodes: GraphNode[];
  edges: GraphEdge[];
  rootKey: string;
  height?: number;
}) {
  const router = useRouter();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const [hovered, setHovered] = useState<SimNode | null>(null);

  // View transform, kept in a ref: it changes on every wheel and drag event and
  // must not trigger a React re-render per frame.
  const viewRef = useRef({ scale: 1, offsetX: 0, offsetY: 0 });
  const simulationRef = useRef<Simulation<SimNode, SimLink> | null>(null);
  const nodesRef = useRef<SimNode[]>([]);
  const linksRef = useRef<SimLink[]>([]);
  const hoveredRef = useRef<SimNode | null>(null);
  /** Set by any interaction that changes what should be on screen. */
  const needsRedrawRef = useRef(true);
  /** Cleared once the view has been auto-fitted to the settled layout. */
  const needsFitRef = useRef(true);
  /**
   * Re-arms the render loop after it has gone idle. Assigned by the render
   * effect; every interaction handler calls it rather than touching rAF
   * directly.
   */
  const requestDrawRef = useRef<(() => void) | null>(null);

  const requestDraw = useCallback(() => {
    requestDrawRef.current?.();
  }, []);

  /**
   * Fits the whole graph into the viewport.
   *
   * Without this the layout is only accidentally visible. A 440-node tree spread
   * over four depth columns puts roughly a hundred nodes in each, and a hundred
   * nodes at collision spacing need far more vertical room than the canvas has -
   * so the columns overflow and the root, pinned to the far left, ends up
   * off-screen. The user is then looking at the middle of a graph with no idea
   * where their own package is.
   *
   * Measuring the settled bounding box and scaling to fit is both the correct
   * fix and one that keeps working for any graph size, rather than tuning
   * constants until one particular package happens to look right.
   */
  const fitToView = useCallback(() => {
    const wrapper = wrapperRef.current;
    const nodes = nodesRef.current;
    if (wrapper === null || nodes.length === 0) return;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const node of nodes) {
      if (node.x === undefined || node.y === undefined) continue;
      minX = Math.min(minX, node.x - node.radius);
      minY = Math.min(minY, node.y - node.radius);
      maxX = Math.max(maxX, node.x + node.radius);
      maxY = Math.max(maxY, node.y + node.radius);
    }
    if (!Number.isFinite(minX)) return;

    const padding = 34; // room for the labels drawn beneath each node
    const width = wrapper.clientWidth;
    const scale = Math.min(
      4,
      Math.max(
        0.2,
        Math.min((width - padding * 2) / (maxX - minX || 1), (height - padding * 2) / (maxY - minY || 1)),
      ),
    );

    viewRef.current = {
      scale,
      offsetX: padding - minX * scale + (width - padding * 2 - (maxX - minX) * scale) / 2,
      offsetY: padding - minY * scale + (height - padding * 2 - (maxY - minY) * scale) / 2,
    };
    needsRedrawRef.current = true;
    requestDrawRef.current?.();
  }, [height]);

  const maxDepth = useMemo(
    () => inputNodes.reduce((deepest, node) => Math.max(deepest, node.depth), 0),
    [inputNodes],
  );

  /* ---------------------------------------------------------------------- */
  /* Simulation                                                              */
  /* ---------------------------------------------------------------------- */

  useEffect(() => {
    const canvas = canvasRef.current;
    const wrapper = wrapperRef.current;
    if (canvas === null || wrapper === null) return;

    // d3-force mutates the objects it is given (adding x, y, vx, vy), so the
    // props are copied rather than annotated in place.
    const simNodes: SimNode[] = inputNodes.map((node) => ({
      ...node,
      radius:
        node.key === rootKey
          ? ROOT_RADIUS
          : NODE_BASE_RADIUS + Math.min(node.vulnerabilityCount, 6) * 0.9,
      worst: worstSeverity(node.severities),
    }));

    const byKey = new Map(simNodes.map((node) => [node.key, node]));
    const simLinks: SimLink[] = inputEdges
      .filter((edge) => byKey.has(edge.fromKey) && byKey.has(edge.toKey))
      .map((edge) => ({
        source: edge.fromKey,
        target: edge.toKey,
        scope: edge.scope,
        range: edge.range,
      }));

    nodesRef.current = simNodes;
    linksRef.current = simLinks;
    // A new dataset (different package, or a changed depth) needs re-framing.
    needsFitRef.current = true;
    viewRef.current = { scale: 1, offsetX: 0, offsetY: 0 };

    const width = wrapper.clientWidth;
    const columnWidth = maxDepth > 0 ? (width * 0.82) / maxDepth : 0;

    /**
     * Force balance.
     *
     * The depth force is deliberately the strongest thing here. Left to
     * themselves, charge and link forces relax a dependency graph into an even
     * blob - technically a valid layout, and useless to look at, because the
     * one piece of structure that matters (how far a package is from you) is
     * exactly what gets averaged away.
     *
     * So `forceX` pins each node hard to its depth column, the link force is
     * weakened so it cannot drag nodes out of their column, and charge does the
     * remaining work of spreading them vertically within it. The result reads
     * as columns: your package, then its direct dependencies, then theirs.
     */
    const simulation = forceSimulation<SimNode, SimLink>(simNodes)
      .force(
        "link",
        forceLink<SimNode, SimLink>(simLinks)
          .id((node) => node.key)
          .distance(30)
          .strength(0.12),
      )
      .force("charge", forceManyBody<SimNode>().strength(-58).distanceMax(220))
      .force(
        "depth",
        forceX<SimNode>((node) => width * 0.08 + node.depth * columnWidth).strength(0.92),
      )
      // Weak pull to the vertical centre so columns stay compact without
      // overwhelming the collision spacing.
      .force("vertical", forceY<SimNode>(height / 2).strength(0.055))
      .force(
        "collide",
        forceCollide<SimNode>((node) => node.radius + 3).strength(0.9).iterations(2),
      )
      .alphaDecay(0.028)
      // Do not start the internal animation timer. See below.
      .stop();

    /**
     * The layout is solved synchronously, not animated into place.
     *
     * `forceSimulation` normally drives itself off `requestAnimationFrame`,
     * repainting after each tick so the graph is seen relaxing. That looks
     * pleasant and costs a surprising amount: the component has to track when
     * the layout is "done", the render loop has to keep running until it is, and
     * every consumer of the final positions - auto-fit, in particular - has to
     * wait for an event that may never arrive if a tick is dropped or the tab is
     * backgrounded.
     *
     * Running the ticks in a loop instead gives the finished layout immediately.
     * The standard formula below is the number of iterations d3 would have run
     * anyway before alpha decayed past its floor, so the result is identical to
     * the animated version - just without the intermediate frames, the timing
     * dependency, and the class of bugs that comes with them.
     *
     * For a few hundred nodes this is a few hundred milliseconds, once, on a
     * layout the user then reads for far longer.
     */
    const iterations = Math.ceil(
      Math.log(simulation.alphaMin()) / Math.log(1 - simulation.alphaDecay()),
    );
    for (let step = 0; step < iterations; step += 1) simulation.tick();

    simulationRef.current = simulation;

    // Positions are final, so the view can be framed right away.
    needsFitRef.current = false;
    fitToView();

    return () => {
      simulation.stop();
      simulationRef.current = null;
    };
  }, [inputNodes, inputEdges, rootKey, height, maxDepth, fitToView]);

  /* ---------------------------------------------------------------------- */
  /* Rendering                                                               */
  /* ---------------------------------------------------------------------- */

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const wrapper = wrapperRef.current;
    if (canvas === null || wrapper === null) return;

    const context = canvas.getContext("2d");
    if (context === null) return;

    const width = wrapper.clientWidth;
    const ratio = window.devicePixelRatio || 1;

    // Resize only when it actually changed - assigning to canvas.width clears
    // the buffer, so doing it every frame would flicker.
    if (canvas.width !== Math.floor(width * ratio) || canvas.height !== Math.floor(height * ratio)) {
      canvas.width = Math.floor(width * ratio);
      canvas.height = Math.floor(height * ratio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
    }

    const view = viewRef.current;
    const active = hoveredRef.current;

    context.save();
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    context.translate(view.offsetX, view.offsetY);
    context.scale(view.scale, view.scale);

    // Neighbours of the hovered node, so everything else can be dimmed.
    const highlighted = new Set<string>();
    if (active !== null) {
      highlighted.add(active.key);
      for (const link of linksRef.current) {
        const source = link.source as SimNode;
        const target = link.target as SimNode;
        if (source.key === active.key) highlighted.add(target.key);
        if (target.key === active.key) highlighted.add(source.key);
      }
    }

    /* --- Edges ---------------------------------------------------------- */

    for (const link of linksRef.current) {
      const source = link.source as SimNode;
      const target = link.target as SimNode;
      if (source.x === undefined || target.x === undefined) continue;

      const isTouching =
        active !== null && (source.key === active.key || target.key === active.key);
      const isDimmed = active !== null && !isTouching;

      context.beginPath();
      context.moveTo(source.x, source.y ?? 0);
      context.lineTo(target.x, target.y ?? 0);
      context.strokeStyle = isTouching
        ? "rgba(94, 233, 181, 0.55)"
        : isDimmed
          ? "rgba(44, 50, 57, 0.28)"
          : "rgba(44, 50, 57, 0.75)";
      context.lineWidth = isTouching ? 1.4 : 0.8;
      // devDependency edges are drawn dashed - the distinction between "ships to
      // production" and "only present while developing" is the single most
      // important thing on this canvas.
      context.setLineDash(link.scope === "dev" ? [3, 3] : []);
      context.stroke();
    }
    context.setLineDash([]);

    /* --- Nodes ---------------------------------------------------------- */

    for (const node of nodesRef.current) {
      if (node.x === undefined || node.y === undefined) continue;

      const isRoot = node.key === rootKey;
      const isDimmed = active !== null && !highlighted.has(node.key);

      const fill =
        node.worst !== null
          ? SEVERITY_HEX[node.worst]
          : isRoot
            ? "#5ee9b5"
            : depthColour(node.depth, maxDepth);

      context.globalAlpha = isDimmed ? 0.22 : 1;

      // Halo behind vulnerable nodes so they read at a glance without having to
      // decode the colour scale.
      if (node.worst !== null && !isDimmed) {
        context.beginPath();
        context.arc(node.x, node.y, node.radius + 4.5, 0, Math.PI * 2);
        context.fillStyle = `${fill}22`;
        context.fill();
      }

      context.beginPath();
      context.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
      context.fillStyle = fill;
      context.fill();

      if (isRoot) {
        context.lineWidth = 2;
        context.strokeStyle = "#08090b";
        context.stroke();
        context.lineWidth = 1.4;
        context.strokeStyle = "#5ee9b5";
        context.beginPath();
        context.arc(node.x, node.y, node.radius + 3.5, 0, Math.PI * 2);
        context.stroke();
      }

      if (node.deprecated && !isDimmed) {
        context.lineWidth = 1.2;
        context.strokeStyle = "#ff9f43";
        context.stroke();
      }

      context.globalAlpha = 1;
    }

    /* --- Labels ---------------------------------------------------------- */
    //
    // Only for the root, the hovered node and its neighbours. Labelling every
    // node at this density produces an unreadable mass of overlapping text.

    context.font =
      "11px ui-monospace, 'SF Mono', 'Cascadia Mono', Menlo, Consolas, monospace";
    context.textAlign = "center";
    context.textBaseline = "top";

    for (const node of nodesRef.current) {
      if (node.x === undefined || node.y === undefined) continue;
      const shouldLabel = node.key === rootKey || (active !== null && highlighted.has(node.key));
      if (!shouldLabel) continue;

      const label = node.packageName;
      const metrics = context.measureText(label);
      const padding = 4;

      context.fillStyle = "rgba(8, 9, 11, 0.86)";
      context.fillRect(
        node.x - metrics.width / 2 - padding,
        node.y + node.radius + 5,
        metrics.width + padding * 2,
        15,
      );

      context.fillStyle = node.key === rootKey ? "#5ee9b5" : "#e9ecef";
      context.fillText(label, node.x, node.y + node.radius + 7);
    }

    context.restore();
  }, [height, maxDepth, rootKey]);

  /**
   * Render loop.
   *
   * The frame callback is always scheduled, but a frame is only *drawn* when
   * something has changed: while the simulation still has energy, or when an
   * interaction has flagged `needsRedraw`. A settled graph with the pointer
   * elsewhere therefore costs one cheap comparison per frame instead of
   * repainting a canvas nobody is looking at.
   *
   * Settling is derived from the simulation's own alpha rather than its `end`
   * event. The event fires once, and anything that misses it - a re-mount, a
   * `restart()` from an interaction - leaves the loading indicator stuck on
   * screen forever. Reading alpha each frame is always correct.
   */
  /**
   * Paint-on-demand.
   *
   * Because the layout is solved up front, there is no animation to drive - the
   * canvas only needs repainting when something the user did changes what should
   * be on it: hovering, panning, zooming, or re-fitting. Each of those calls
   * `requestDraw`, which coalesces into at most one paint per frame.
   *
   * The page is genuinely idle the rest of the time, which is the difference
   * between a static visualisation and one that quietly burns a core for as long
   * as the tab is open.
   */
  useEffect(() => {
    let frame: number | null = null;

    requestDrawRef.current = () => {
      needsRedrawRef.current = true;
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        if (!needsRedrawRef.current) return;
        needsRedrawRef.current = false;
        draw();
      });
    };

    // First paint.
    requestDrawRef.current();

    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      requestDrawRef.current = null;
    };
  }, [draw]);

  /* ---------------------------------------------------------------------- */
  /* Interaction                                                             */
  /* ---------------------------------------------------------------------- */

  /** Screen coordinates -> simulation coordinates, undoing the view transform. */
  const toGraphSpace = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (canvas === null) return null;
    const rect = canvas.getBoundingClientRect();
    const view = viewRef.current;
    return {
      x: (clientX - rect.left - view.offsetX) / view.scale,
      y: (clientY - rect.top - view.offsetY) / view.scale,
    };
  }, []);

  const nodeAt = useCallback(
    (clientX: number, clientY: number): SimNode | null => {
      const point = toGraphSpace(clientX, clientY);
      if (point === null) return null;

      // Reverse order so the visually topmost node wins a tie.
      for (let index = nodesRef.current.length - 1; index >= 0; index -= 1) {
        const node = nodesRef.current[index];
        if (node?.x === undefined || node.y === undefined) continue;
        const dx = point.x - node.x;
        const dy = point.y - node.y;
        // Generous target: exact-radius hit-testing on a 5px circle is unusable.
        const reach = node.radius + 5;
        if (dx * dx + dy * dy <= reach * reach) return node;
      }
      return null;
    },
    [toGraphSpace],
  );

  const dragState = useRef<{ x: number; y: number; moved: boolean } | null>(null);

  return (
    <div className="relative">
      <div
        ref={wrapperRef}
        className="grid-backdrop relative overflow-hidden rounded-xl border border-[var(--color-line)] bg-[var(--color-ground)]"
        style={{ height }}
      >
        <canvas
          ref={canvasRef}
          className={dragState.current !== null ? "cursor-grabbing" : "cursor-grab"}
          role="img"
          aria-label={`Dependency graph with ${inputNodes.length} packages and ${inputEdges.length} dependency links`}
          onMouseDown={(event) => {
            dragState.current = { x: event.clientX, y: event.clientY, moved: false };
          }}
          onMouseMove={(event) => {
            const drag = dragState.current;
            if (drag !== null) {
              const dx = event.clientX - drag.x;
              const dy = event.clientY - drag.y;
              if (Math.abs(dx) > 2 || Math.abs(dy) > 2) drag.moved = true;
              viewRef.current.offsetX += dx;
              viewRef.current.offsetY += dy;
              drag.x = event.clientX;
              drag.y = event.clientY;
              requestDraw();
              return;
            }

            const node = nodeAt(event.clientX, event.clientY);
            if (node?.key !== hoveredRef.current?.key) {
              hoveredRef.current = node;
              requestDraw();
              setHovered(node);
            }
          }}
          onMouseUp={() => {
            dragState.current = null;
          }}
          onMouseLeave={() => {
            dragState.current = null;
            hoveredRef.current = null;
            requestDraw();
            setHovered(null);
          }}
          onClick={(event) => {
            // Suppress the click that ends a pan gesture.
            if (dragState.current?.moved === true) return;
            const node = nodeAt(event.clientX, event.clientY);
            if (node === null || node.key === rootKey) return;
            router.push(packageHref(node.packageName, node.version));
          }}
          onWheel={(event) => {
            const point = toGraphSpace(event.clientX, event.clientY);
            if (point === null) return;
            const view = viewRef.current;
            const factor = event.deltaY < 0 ? 1.12 : 1 / 1.12;
            const next = Math.min(4, Math.max(0.35, view.scale * factor));
            // Anchor the zoom on the cursor rather than the origin, so the point
            // under the pointer stays put.
            view.offsetX -= point.x * (next - view.scale);
            view.offsetY -= point.y * (next - view.scale);
            view.scale = next;
            requestDraw();
          }}
        />

        {hovered !== null && <NodeTooltip node={hovered} />}

        <div className="absolute bottom-3 right-3 flex items-center gap-2">
          <button
            type="button"
            onClick={() => fitToView()}
            className="rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-surface)]/90 px-2.5 py-1.5 text-[11px] text-[var(--color-ink-muted)] transition-colors hover:bg-[var(--color-surface-hover)] hover:text-[var(--color-ink)]"
          >
            fit to view
          </button>
          <span className="pointer-events-none rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)]/90 px-2.5 py-1.5 text-[11px] text-[var(--color-ink-faint)]">
            scroll to zoom | drag to pan | click a node to open it
          </span>
        </div>
      </div>

      <Legend maxDepth={maxDepth} />
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Supporting pieces                                                           */
/* -------------------------------------------------------------------------- */

/** Nodes with no advisories are shaded by depth, fading as they recede. */
function depthColour(depth: number, maxDepth: number): string {
  if (maxDepth === 0) return "#5ee9b5";
  const t = Math.min(1, depth / Math.max(1, maxDepth));
  const lightness = 78 - t * 34;
  const saturation = 12 + (1 - t) * 8;
  return `hsl(205, ${saturation}%, ${lightness}%)`;
}

function NodeTooltip({ node }: { node: SimNode }) {
  return (
    <div className="pointer-events-none absolute left-3 bottom-3 max-w-xs rounded-lg border border-[var(--color-line-strong)] bg-[var(--color-surface-raised)] px-3 py-2 shadow-xl">
      <p className="font-mono text-[12px] text-[var(--color-ink)]">
        {node.packageName}
        <span className="text-[var(--color-ink-faint)]">@{node.version}</span>
      </p>
      <p className="mt-1 text-[11px] text-[var(--color-ink-faint)]">
        {node.depth === 0 ? "the package you are auditing" : `${node.depth} hop${node.depth === 1 ? "" : "s"} away`}
      </p>
      {node.vulnerabilityCount > 0 && (
        <p className="mt-1 text-[11px]" style={{ color: SEVERITY_HEX[node.worst ?? "UNKNOWN"] }}>
          {node.vulnerabilityCount} advisor{node.vulnerabilityCount === 1 ? "y" : "ies"}
          {node.worst !== null && ` | worst ${node.worst.toLowerCase()}`}
        </p>
      )}
      {node.deprecated && (
        <p className="mt-1 text-[11px] text-[var(--color-high)]">deprecated by its maintainer</p>
      )}
    </div>
  );
}

function Legend({ maxDepth }: { maxDepth: number }) {
  const severities: Severity[] = ["CRITICAL", "HIGH", "MODERATE", "LOW"];

  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 px-1 text-[11.5px] text-[var(--color-ink-faint)]">
      <span className="flex items-center gap-1.5">
        <span className="h-2.5 w-2.5 rounded-full ring-2 ring-[var(--color-accent)] ring-offset-2 ring-offset-[var(--color-ground)]" style={{ background: "#5ee9b5" }} />
        this package
      </span>

      {severities.map((severity) => (
        <span key={severity} className="flex items-center gap-1.5">
          <span
            className="h-2.5 w-2.5 rounded-full"
            style={{ background: SEVERITY_HEX[severity] }}
          />
          {severity.toLowerCase()}
        </span>
      ))}

      <span className="flex items-center gap-1.5">
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: depthColour(maxDepth, maxDepth) }} />
        no known advisory
      </span>

      <span className="flex items-center gap-1.5">
        <svg width="22" height="6" aria-hidden>
          <line x1="0" y1="3" x2="22" y2="3" stroke="#2c3239" strokeWidth="1.5" strokeDasharray="3 3" />
        </svg>
        dev-only dependency
      </span>
    </div>
  );
}
