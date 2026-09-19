import type { JsonArray, JsonObject, JsonValue } from "./types.js";

/**
 * Deep-clone a JSON value by hand.
 *
 * Why not `JSON.parse(JSON.stringify(value))`:
 *  - stringify invokes `toJSON()` on plain objects that happen to carry
 *    one, silently changing the cloned data;
 *  - it loses `undefined`-in-array distinctions and throws on cycles with
 *    an opaque error;
 *  - performance for large documents is dominated by serialization
 *    bookkeeping and cannot be reasoned about locally.
 *
 * Structural cycles are rejected explicitly. The `seen` map keys live
 * nodes already copied, so cost is linear in subtree size.
 */
export function cloneJson<T extends JsonValue>(value: T): T {
  return cloneNode(value, new Map<object, JsonArray | JsonObject>()) as T;
}

function cloneNode(
  value: JsonValue,
  seen: Map<object, JsonArray | JsonObject>,
): JsonValue {
  if (value === null || typeof value !== "object") {
    return value; // primitives are immutable
  }
  const cached = seen.get(value);
  if (cached !== undefined) {
    throw new CyclicValueError();
  }
  if (Array.isArray(value)) {
    const copy: JsonArray = [];
    seen.set(value, copy);
    for (const item of value) {
      copy.push(cloneNode(item, seen));
    }
    return copy;
  }
  const copy: JsonObject = {};
  seen.set(value, copy);
  for (const key of Object.keys(value)) {
    copy[key] = cloneNode(value[key] as JsonValue, seen);
  }
  return copy;
}

/** Raised when a value marked as JSON actually contains a reference cycle. */
export class CyclicValueError extends Error {
  override readonly name = "CyclicValueError";
  constructor() {
    super("Cannot clone a cyclic value: JSON documents must be acyclic");
  }
}

/**
 * RFC 6902 deep equality.
 *
 * Objects compare as equal when they have the same set of members (member
 * order is irrelevant) and every member compares equal; arrays compare
 * element-wise; primitives use strict equality.
 *
 * @returns a pointer (relative to the compared values, `""` = the values
 *          themselves) of the first location that differs, or `null` when
 *          the values are equal.
 */
export function firstDifference(
  actual: JsonValue,
  expected: JsonValue,
): string | null {
  return diffAt(actual, expected, []);
}

function diffAt(
  actual: JsonValue,
  expected: JsonValue,
  prefix: string[],
): string | null {
  if (actual === expected) {
    return null;
  }
  if (
    actual === null ||
    expected === null ||
    typeof actual !== "object" ||
    typeof expected !== "object"
  ) {
    return formatRelative(prefix);
  }
  const actualIsArray = Array.isArray(actual);
  const expectedIsArray = Array.isArray(expected);
  if (actualIsArray !== expectedIsArray) {
    return formatRelative(prefix);
  }
  if (actualIsArray && expectedIsArray) {
    const a = actual as JsonArray;
    const b = expected as JsonArray;
    if (a.length !== b.length) {
      return formatRelative(prefix);
    }
    for (let i = 0; i < a.length; i++) {
      const diff = diffAt(a[i] as JsonValue, b[i] as JsonValue, [
        ...prefix,
        String(i),
      ]);
      if (diff !== null) {
        return diff;
      }
    }
    return null;
  }
  const a = actual as JsonObject;
  const b = expected as JsonObject;
  const aKeys = Object.keys(a);
  const bKeys = new Set(Object.keys(b));
  if (aKeys.length !== bKeys.size) {
    return formatRelative(prefix);
  }
  for (const key of aKeys) {
    if (!bKeys.has(key)) {
      return formatRelative(prefix);
    }
    const diff = diffAt(a[key] as JsonValue, b[key] as JsonValue, [
      ...prefix,
      key,
    ]);
    if (diff !== null) {
      return diff;
    }
  }
  return null;
}

function formatRelative(tokens: string[]): string {
  let pointer = "";
  for (const token of tokens) {
    pointer += "/" + token.replace(/~/g, "~0").replace(/\//g, "~1");
  }
  return pointer;
}
