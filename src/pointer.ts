/**
 * JSON Pointer (RFC 6901) parsing and formatting.
 *
 * A pointer is either the empty string ("", the whole document) or a
 * sequence of `/`-prefixed reference tokens. Two characters are escaped
 * inside tokens: `~` as `~0` and `/` as `~1`. Unescape must be applied
 * after splitting on `/`, otherwise a `~1` would never have produced a
 * segment boundary.
 */

/** Parsed reference tokens (already unescaped). Empty array = root pointer. */
export type PointerTokens = readonly string[];

/** Failure raised while lexing a pointer string into reference tokens. */
export class PointerSyntaxError extends Error {
  override readonly name = "PointerSyntaxError";
  /** Which operation field held the bad pointer: `path` or `from`. */
  readonly pointerName: "path" | "from";
  /** The malformed pointer as supplied by the caller. */
  readonly pointer: string;

  constructor(pointerName: "path" | "from", pointer: unknown) {
    super(
      `Invalid JSON Pointer in "${pointerName}": expected a string, got ${describeValue(pointer)}`,
    );
    this.pointerName = pointerName;
    this.pointer = typeof pointer === "string" ? pointer : String(pointer);
  }
}

/**
 * Parse a JSON Pointer string into unescaped reference tokens.
 *
 * @throws PointerSyntaxError when `pointer` is not a string or a `~` escape
 *         sequence is malformed (`~` must be followed by `0` or `1`).
 */
export function parsePointer(
  pointer: unknown,
  pointerName: "path" | "from" = "path",
): PointerTokens {
  if (typeof pointer !== "string") {
    throw new PointerSyntaxError(pointerName, pointer);
  }
  if (pointer === "") {
    return [];
  }
  // Every non-root pointer begins with '/'.
  if (pointer.charCodeAt(0) !== 0x2f) {
    throw new PointerSyntaxError(pointerName, pointer);
  }

  const tokens: string[] = [];
  const length = pointer.length;
  let segment = "";

  // Start after the leading '/'.
  for (let i = 1; i < length; i++) {
    const code = pointer.charCodeAt(i);
    if (code === 0x2f /* '/' */) {
      tokens.push(segment);
      segment = "";
      continue;
    }
    if (code === 0x7e /* '~' */) {
      const next = pointer.charCodeAt(i + 1);
      if (next === 0x30 /* '0' */) {
        segment += "~";
        i++;
        continue;
      }
      if (next === 0x31 /* '1' */) {
        segment += "/";
        i++;
        continue;
      }
      throw new PointerSyntaxError(pointerName, pointer);
    }
    segment += pointer[i];
  }
  tokens.push(segment);
  return tokens;
}

/**
 * Serialize reference tokens back into a JSON Pointer string, escaping `~`
 * and `/` correctly. Note the required escape order: `~` first, then `/`
 * (escaping `/` before `~` would corrupt the inserted tildes).
 */
export function formatPointer(tokens: PointerTokens): string {
  let pointer = "";
  for (const token of tokens) {
    pointer += "/" + token.replace(/~/g, "~0").replace(/\//g, "~1");
  }
  return pointer;
}

/**
 * Interpret a reference token as an RFC 6902 array index.
 *
 * Rules: digits only, no leading zero (except the single token "0"), and
 * the value must be <= 2**32 - 1. The token "-" is *not* an index — it is
 * the append marker and is handled separately by callers.
 *
 * @returns the numeric index, or `null` when the token is not a legal
 *          array index (callers then decide whether that is an error).
 */
export function parseArrayIndex(token: string): number | null {
  if (token === "-" || token === "") {
    return null;
  }
  const length = token.length;
  if (length > 1 && token.charCodeAt(0) === 0x30 /* '0' */) {
    return null; // leading zero
  }
  let index = 0;
  for (let i = 0; i < length; i++) {
    const code = token.charCodeAt(i);
    if (code < 0x30 || code > 0x39) {
      return null;
    }
    index = index * 10 + (code - 0x30);
  }
  if (index > 0xffffffff) {
    return null;
  }
  return index;
}

/** Whether `token` is the array append marker "-". */
export function isAppendToken(token: string): boolean {
  return token === "-";
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  return typeof value;
}
