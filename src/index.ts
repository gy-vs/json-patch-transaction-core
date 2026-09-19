/**
 * json-patch-transaction-core
 *
 * In-memory RFC 6902 JSON Patch with atomic, copy-on-write application.
 *
 * @example
 * ```ts
 * import { applyPatch } from "./index.js";
 *
 * const result = applyPatch({ a: [1, 2] }, [
 *   { op: "add", path: "/a/-", value: 3 },
 *   { op: "test", path: "/a/2", value: 3 },
 * ]);
 * // result.ok === true, result.doc === { a: [1, 2, 3] }
 * ```
 *
 * On failure `result.ok` is false, `result.doc` is the *same reference*
 * as the input document, and `result.errors[0]` locates the failing step.
 */
export { applyPatch } from "./patch.js";
export {
  parsePointer,
  formatPointer,
  parseArrayIndex,
  isAppendToken,
  PointerSyntaxError,
  type PointerTokens,
} from "./pointer.js";
export { cloneJson, firstDifference, CyclicValueError } from "./clone.js";
export type {
  JsonValue,
  JsonObject,
  JsonArray,
  JsonPrimitive,
  JsonPointer,
  PatchOperation,
  AddOperation,
  RemoveOperation,
  ReplaceOperation,
  MoveOperation,
  CopyOperation,
  TestOperation,
  ApplyResult,
  OpError,
  ErrorCode,
} from "./types.js";
