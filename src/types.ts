/**
 * A value representable as JSON. `null` is included in the primitive union
 * rather than hidden behind `object`, so `JsonValue | undefined` style
 * signatures stay unambiguous.
 */
export type JsonPrimitive = string | number | boolean | null;
export type JsonObject = { [key: string]: JsonValue };
export type JsonArray = JsonValue[];
export type JsonValue = JsonPrimitive | JsonObject | JsonArray;

/** JSON Pointer string (RFC 6901), e.g. `""`, `"/a/b~1c/0"`, `"/arr/-"`. */
export type JsonPointer = string;

export interface AddOperation {
  op: "add";
  path: JsonPointer;
  value: JsonValue;
}

export interface RemoveOperation {
  op: "remove";
  path: JsonPointer;
}

export interface ReplaceOperation {
  op: "replace";
  path: JsonPointer;
  value: JsonValue;
}

export interface MoveOperation {
  op: "move";
  from: JsonPointer;
  path: JsonPointer;
}

export interface CopyOperation {
  op: "copy";
  from: JsonPointer;
  path: JsonPointer;
}

/**
 * `test` asserts that the value at `path` is deep-equal to `value`
 * (RFC 6902 §4.6). A failed test fails and rolls back the whole patch.
 */
export interface TestOperation {
  op: "test";
  path: JsonPointer;
  value: JsonValue;
}

/** One of the six RFC 6902 operations. */
export type PatchOperation =
  | AddOperation
  | RemoveOperation
  | ReplaceOperation
  | MoveOperation
  | CopyOperation
  | TestOperation;

/**
 * Machine-readable failure classifications.
 *
 * - `MALFORMED_OPERATION`  operation object missing required fields / wrong types
 * - `POINTER_SYNTAX`        malformed JSON Pointer (bad `~` escape, non-string)
 * - `PATH_NOT_FOUND`        traversal hit a missing object member / array element
 * - `INVALID_ARRAY_INDEX`  token is neither an index nor "-" on an array
 * - `INDEX_OUT_OF_BOUNDS`  numeric index outside the legal range for the op
 * - `TYPE_MISMATCH`        traversing through a primitive (null/string/number/boolean)
 * - `MOVE_INTO_DESCENDANT` `from` is a proper prefix of `path` (RFC 6902 §4.4)
 * - `REMOVE_ROOT`          `remove` targeted the whole document
 * - `TEST_FAILED`          `test` comparison mismatch
 * - `CYCLIC_VALUE`         a copied subtree contains a cycle (not JSON)
 */
export type ErrorCode =
  | "MALFORMED_OPERATION"
  | "POINTER_SYNTAX"
  | "PATH_NOT_FOUND"
  | "INVALID_ARRAY_INDEX"
  | "INDEX_OUT_OF_BOUNDS"
  | "TYPE_MISMATCH"
  | "MOVE_INTO_DESCENDANT"
  | "REMOVE_ROOT"
  | "TEST_FAILED"
  | "CYCLIC_VALUE";

/** Structured information about the failing step and where it failed. */
export interface OpError {
  /** Zero-based position of the operation inside the supplied patch. */
  index: number;
  /** The `op` name when known, otherwise `null` (e.g. malformed object). */
  op: string | null;
  code: ErrorCode;
  /** Human-readable, diagnostic-only description. */
  message: string;
  /**
   * Pointer of the location implicated by the failure:
   * - `path`   the failure was at/under the operation's `path`
   * - `from`   the failure was at/under the operation's `from`
   * - `null`   no specific pointer (e.g. malformed operation)
   */
  pointerField: "path" | "from" | null;
  /**
   * The deepest pointer that *was* successfully resolved, formatted as a
   * JSON Pointer. `""` means the failure occurred at the document root.
   */
  resolvedPath: JsonPointer;
  /** The token that could not be resolved, if traversal failed mid-pointer. */
  failedToken: string | null;
  /** For `TEST_FAILED`: pointer to the first value that differed. */
  mismatchPath?: JsonPointer;
}

/** Result of applying a patch. Exactly one outcome is meaningful. */
export interface ApplyResult<T extends JsonValue = JsonValue> {
  /**
   * The new document on success. On failure this is *the same reference*
   * as the input document — callers can compare with `===` to detect
   * rollback without inspecting `errors`.
   */
  doc: T;
  /** `true` when every operation applied. */
  ok: boolean;
  /**
   * One entry for the failing step on failure (atomic: processing stops
   * at the first error), empty on success.
   */
  errors: OpError[];
}
