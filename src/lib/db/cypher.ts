/**
 * A Cypher statement that is guaranteed to be a static literal.
 *
 * ## Why this exists
 *
 * "Parameterised queries, no string-concatenated Cypher" is easy to say and easy
 * to violate six months later when someone needs a dynamic label. Rather than
 * rely on discipline, this module makes the unsafe thing not compile:
 *
 *  - {@link Cypher} is a *branded* string. A plain `string` — including any
 *    result of `+` or of an interpolated template literal — is not assignable
 *    to it.
 *  - The only way to produce a `Cypher` is the {@link cypher} tagged template,
 *    which throws at module-load time if the template had any `${...}`
 *    substitutions at all.
 *  - `readRows` / `writeRows` in `driver.ts` accept `Cypher` and nothing else.
 *
 * So an attempt to write:
 *
 * ```ts
 * const q = cypher`MATCH (p:Package {name: "${userInput}"}) RETURN p`;
 * ```
 *
 * fails the moment the module is imported, with a message pointing at the fix.
 * The supported form is always:
 *
 * ```ts
 * const q = cypher`MATCH (p:Package {name: $name}) RETURN p`;
 * // ... readRows(q, { name: userInput })
 * ```
 *
 * The single `as unknown as Cypher` cast below is the one place in the codebase
 * where the brand is minted, and it is only reachable when the template
 * provably had no interpolation.
 */
import neo4j, { type Integer } from "neo4j-driver";

declare const CYPHER_BRAND: unique symbol;

export type Cypher = string & { readonly [CYPHER_BRAND]: true };

export function cypher(strings: TemplateStringsArray, ...values: unknown[]): Cypher {
  if (values.length > 0) {
    throw new Error(
      "Interpolation into a Cypher statement is forbidden. Values must be passed as " +
        "$parameters to readRows/writeRows so the driver sends them out-of-band. " +
        "If you need a dynamic label or relationship type, add an explicit branch " +
        "with one static statement per case.",
    );
  }
  // Safe: `values.length === 0` means `strings` holds exactly one static chunk.
  return strings[0] as unknown as Cypher;
}

/**
 * Values accepted as query parameters. Deliberately narrow: the driver will
 * happily accept `undefined` and turn it into a silent `null` mismatch, which
 * produces empty result sets that look like real "no data" answers.
 *
 * `Integer` is in the union because of a sharp edge in the Bolt type system —
 * see {@link int}.
 */
export type ParamValue =
  | string
  | number
  | boolean
  | null
  | Integer
  | readonly string[]
  | readonly number[]
  | readonly ParamValue[]
  | { readonly [key: string]: ParamValue };

export type Params = Readonly<Record<string, ParamValue>>;

/**
 * Marks a number as a Bolt INTEGER rather than a FLOAT.
 *
 * JavaScript has one number type; Bolt has two. The driver cannot tell whether
 * `10` means the integer 10 or the float 10.0, so it sends every plain number as
 * a FLOAT. Most of the time that is harmless — but a handful of Cypher
 * constructs are strict about it, and `LIMIT` is the one you hit first:
 *
 *     LIMIT $limit   with { limit: 10 }
 *     → "LIMIT: Invalid input. '10.0' is not a valid value."
 *
 * The same applies to any integer-valued property being written: a download
 * count stored as `1.234e7` is not just cosmetically wrong, it sorts and
 * compares differently from the integer it should have been.
 *
 * So every genuinely-integral parameter goes through this function. It is
 * `neo4j.int` with a name that says why it is there.
 */
export function int(value: number): Integer {
  if (!Number.isInteger(value)) {
    throw new TypeError(
      `int() expects a whole number, received ${value}. ` +
        `If a fractional value is intended, pass it as a plain number so it is sent as a FLOAT.`,
    );
  }
  return neo4j.int(value);
}

/**
 * Guards against the `undefined` footgun described above. Called on every query
 * so a missing parameter is a loud error instead of a plausible-looking empty
 * table.
 */
export function assertNoUndefinedParams(params: Params, statementName: string): void {
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) {
      throw new Error(
        `Query "${statementName}" was given \`undefined\` for parameter $${key}. ` +
          `Cypher has no undefined — pass null explicitly if that is what you mean.`,
      );
    }
  }
}
