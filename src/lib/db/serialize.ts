import {
  isDate,
  isDateTime,
  isDuration,
  isInt,
  isLocalDateTime,
  isLocalTime,
  isNode,
  isPath,
  isPathSegment,
  isPoint,
  isRelationship,
  isTime,
  type Integer,
  type Node as Neo4jNode,
  type Path as Neo4jPath,
  type Relationship as Neo4jRelationship,
} from "neo4j-driver";

/**
 * Bolt → JSON.
 *
 * The driver returns rich types — 64-bit `Integer`, `Node`, `Relationship`,
 * `Path`, temporal and spatial values — none of which survive `JSON.stringify`
 * in a form the browser can use. `Integer` in particular stringifies to
 * `{"low":3,"high":0}`, which is a classic source of "why is my count an
 * object?" bugs.
 *
 * Every value crossing the API boundary goes through {@link toPlain}, so the
 * React layer only ever deals with `number | string | boolean | null` and plain
 * objects/arrays.
 */

export interface PlainNode {
  id: string;
  labels: string[];
  properties: Record<string, unknown>;
}

export interface PlainRelationship {
  id: string;
  type: string;
  startId: string;
  endId: string;
  properties: Record<string, unknown>;
}

export interface PlainPath {
  length: number;
  nodes: PlainNode[];
  relationships: PlainRelationship[];
}

/**
 * Narrows a 64-bit Bolt integer to a JS number.
 *
 * Everything this application stores in an integer field is a count, a depth, a
 * byte size, or a millisecond timestamp — all comfortably inside
 * `Number.MAX_SAFE_INTEGER`. We still check rather than assume: silently losing
 * precision is worse than a loud failure, and the check costs nothing.
 */
export function intToNumber(value: unknown): number {
  // A numeric column does not always arrive as a Bolt INTEGER. Aggregations like
  // `count()` and `size()` do return one, but a property that was written from a
  // plain JavaScript number comes back as a FLOAT, and `avg()`/`max()` over
  // floats stay floats. Accepting both keeps every call site from having to know
  // which kind of number a given expression produced.
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);

  if (!isInt(value)) {
    throw new TypeError(
      `Expected a numeric value, received ${value === null ? "null" : typeof value}.`,
    );
  }

  const asInteger = value as Integer;
  if (!asInteger.inSafeRange()) {
    throw new RangeError(
      `Integer ${asInteger.toString()} exceeds Number.MAX_SAFE_INTEGER and cannot be ` +
        `converted losslessly. If this is legitimate data, widen the field to a string.`,
    );
  }
  return asInteger.toNumber();
}

/** `intToNumber` for columns that are legitimately nullable. */
export function optionalNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : intToNumber(value);
}

export function toPlainNode(node: Neo4jNode): PlainNode {
  return {
    id: node.elementId,
    labels: [...node.labels],
    properties: toPlain(node.properties) as Record<string, unknown>,
  };
}

export function toPlainRelationship(rel: Neo4jRelationship): PlainRelationship {
  return {
    id: rel.elementId,
    type: rel.type,
    startId: rel.startNodeElementId,
    endId: rel.endNodeElementId,
    properties: toPlain(rel.properties) as Record<string, unknown>,
  };
}

export function toPlainPath(path: Neo4jPath): PlainPath {
  return {
    length: path.length,
    nodes: [path.start, ...path.segments.map((segment) => segment.end)].map(toPlainNode),
    relationships: path.segments.map((segment) => toPlainRelationship(segment.relationship)),
  };
}

/**
 * Recursively converts any driver value into something `JSON.stringify` handles
 * faithfully. Unknown types fall through to their `toString()`, which is the
 * right call for the spatial/temporal types we don't model explicitly.
 */
export function toPlain(value: unknown): unknown {
  if (value === null || value === undefined) return null;

  const primitive = typeof value;
  if (primitive === "string" || primitive === "number" || primitive === "boolean") {
    return value;
  }
  if (primitive === "bigint") return Number(value as bigint);

  if (isInt(value)) return intToNumber(value);
  if (isNode(value)) return toPlainNode(value);
  if (isRelationship(value)) return toPlainRelationship(value);
  if (isPath(value)) return toPlainPath(value);
  if (isPathSegment(value)) {
    return {
      start: toPlainNode(value.start),
      relationship: toPlainRelationship(value.relationship),
      end: toPlainNode(value.end),
    };
  }

  // Temporal and spatial values all have faithful `toString()` implementations
  // (ISO-8601 for temporals, WKT-ish for points).
  if (
    isDate(value) ||
    isDateTime(value) ||
    isLocalDateTime(value) ||
    isLocalTime(value) ||
    isTime(value) ||
    isDuration(value) ||
    isPoint(value)
  ) {
    return value.toString();
  }

  if (Array.isArray(value)) return value.map(toPlain);

  if (primitive === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      out[key] = toPlain(nested);
    }
    return out;
  }

  return String(value);
}
