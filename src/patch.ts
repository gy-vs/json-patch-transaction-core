import type {
  ApplyResult,
  ErrorCode,
  JsonObject,
  JsonPointer,
  JsonValue,
  OpError,
  PatchOperation,
} from "./types.js";
import {
  formatPointer,
  isAppendToken,
  parseArrayIndex,
  parsePointer,
  PointerSyntaxError,
  type PointerTokens,
} from "./pointer.js";
import {
  CyclicValueError,
  cloneJson,
  firstDifference,
} from "./clone.js";

/**
 * Internal failure carrier. It records how many leading tokens were
 * resolved so the public {@link OpError} can report a precise location
 * without every call site threading that state manually.
 */
class StepError extends Error {
  readonly code: ErrorCode;
  readonly pointerField: "path" | "from";
  readonly resolvedTokens: PointerTokens;
  readonly failedToken: string | null;
  readonly mismatchPath?: JsonPointer;
  /** Filled in by {@link runStep} once the operation index is known. */
  opIndex: number;
  opName: string | null;

  constructor(
    code: ErrorCode,
    message: string,
    pointerField: "path" | "from",
    resolvedTokens: PointerTokens = [],
    failedToken: string | null = null,
    mismatchPath?: JsonPointer,
  ) {
    super(message);
    this.name = "StepError";
    this.code = code;
    this.pointerField = pointerField;
    this.resolvedTokens = resolvedTokens;
    this.failedToken = failedToken;
    if (mismatchPath !== undefined) {
      this.mismatchPath = mismatchPath;
    }
    this.opIndex = -1;
    this.opName = null;
  }
}

/**
 * Apply a JSON Patch (RFC 6902) atomically.
 *
 * The input document is never mutated: every operation builds a new
 * version by copying only the spine of nodes it touches ("copy on
 * write"). If any step fails, processing stops immediately and
 * `result.doc === doc` — there is no rollback phase that could itself
 * fail, and earlier steps leave no partial state anywhere.
 *
 * @param doc   any JSON-compatible value (object, array or primitive)
 * @param patch ordered list of operations
 */
export function applyPatch<T extends JsonValue>(
  doc: T,
  patch: readonly PatchOperation[],
): ApplyResult<T> {
  if (!Array.isArray(patch)) {
    throw new TypeError("applyPatch: patch must be an array of operations");
  }

  // Phase 1: structural validation, pointer parsing and value cloning.
  // Nothing about `doc` is touched, so a malformed operation simply reports
  // its position and the input reference is returned unchanged.
  const operations: ParsedOp[] = [];
  for (let index = 0; index < patch.length; index++) {
    const parsed = prepareOperation(patch[index], index);
    if (parsed instanceof OpErrorImpl) {
      return failure(doc, parsed.toOpError());
    }
    operations.push(parsed);
  }

  // Phase 2: execution over immutable versions. `current` is replaced with
  // a freshly rooted value on every successful step; the caller's `doc`
  // stays untouched regardless of what happens below.
  let current: JsonValue = doc;
  for (const [index, operation] of operations.entries()) {
    try {
      current = runStep(current, operation, index);
    } catch (error) {
      if (error instanceof StepError) {
        return failure(doc, toOpError(error));
      }
      throw error;
    }
  }

  return { doc: current as T, ok: true, errors: [] };
}

// ---------------------------------------------------------------------------
// Operation validation / preparation
// ---------------------------------------------------------------------------

type ParsedOp =
  | { kind: "add"; path: PointerTokens; value: JsonValue }
  | { kind: "remove"; path: PointerTokens }
  | { kind: "replace"; path: PointerTokens; value: JsonValue }
  | { kind: "move"; from: PointerTokens; path: PointerTokens }
  | { kind: "copy"; from: PointerTokens; path: PointerTokens }
  | { kind: "test"; path: PointerTokens; value: JsonValue };

/** Error carrier used during phase 1 (before an op is even parsed). */
class OpErrorImpl {
  constructor(private readonly error: OpError) {}
  toOpError(): OpError {
    return this.error;
  }
}

function prepareOperation(
  op: unknown,
  index: number,
): ParsedOp | OpErrorImpl {
  const malformed = (message: string): OpErrorImpl =>
    new OpErrorImpl({
      index,
      op: extractOpName(op),
      code: "MALFORMED_OPERATION",
      message,
      pointerField: null,
      resolvedPath: "",
      failedToken: null,
    });

  if (typeof op !== "object" || op === null || Array.isArray(op)) {
    return malformed("operation must be a non-null object");
  }
  const candidate = op as Record<string, unknown>;
  const kind = candidate["op"];
  if (
    kind !== "add" &&
    kind !== "remove" &&
    kind !== "replace" &&
    kind !== "move" &&
    kind !== "copy" &&
    kind !== "test"
  ) {
    return malformed(
      '"op" must be one of add, remove, replace, move, copy, test',
    );
  }
  if (typeof candidate["path"] !== "string") {
    return malformed('"path" must be a JSON Pointer string');
  }
  if (
    (kind === "move" || kind === "copy") &&
    typeof candidate["from"] !== "string"
  ) {
    return malformed('"from" must be a JSON Pointer string');
  }
  if (
    (kind === "add" || kind === "replace" || kind === "test") &&
    !isJsonLike(candidate["value"])
  ) {
    return malformed('"value" is required and must be a JSON-compatible value');
  }

  try {
    const path = parsePointer(candidate["path"], "path");
    switch (kind) {
      case "add":
      case "replace":
        return { kind, path, value: cloneJson(candidate["value"] as JsonValue) };
      case "test":
        // Clone so a later mutation of the caller's expected value cannot
        // change a previously computed result.
        return { kind, path, value: cloneJson(candidate["value"] as JsonValue) };
      case "remove":
        return { kind, path };
      case "move":
      case "copy":
        return {
          kind,
          path,
          from: parsePointer(candidate["from"], "from"),
        };
    }
  } catch (error) {
    return new OpErrorImpl(toPreError(error, index, kind));
  }
  /* unreachable */
  return malformed("unreachable");
}

function isJsonLike(value: unknown): boolean {
  if (value === null) return true;
  const type = typeof value;
  return (
    type === "string" ||
    type === "number" ||
    type === "boolean" ||
    type === "object"
  );
}

function extractOpName(op: unknown): string | null {
  if (typeof op === "object" && op !== null) {
    const name = (op as Record<string, unknown>)["op"];
    if (typeof name === "string") return name;
  }
  return null;
}

function toPreError(error: unknown, index: number, opName: string): OpError {
  if (error instanceof CyclicValueError) {
    return {
      index,
      op: opName,
      code: "CYCLIC_VALUE",
      message: error.message,
      pointerField: "path",
      resolvedPath: "",
      failedToken: null,
    };
  }
  if (error instanceof PointerSyntaxError) {
    return {
      index,
      op: opName,
      code: "POINTER_SYNTAX",
      message: error.message,
      pointerField: error.pointerName,
      resolvedPath: "",
      failedToken: null,
    };
  }
  throw error;
}

// ---------------------------------------------------------------------------
// Step execution
// ---------------------------------------------------------------------------

function runStep(
  current: JsonValue,
  op: ParsedOp,
  index: number,
): JsonValue {
  try {
    switch (op.kind) {
      case "add":
        if (op.path.length === 0) {
          return op.value;
        }
        return addAt(current, op.path, 0, op.value, "path");
      case "remove":
        if (op.path.length === 0) {
          throw new StepError(
            "REMOVE_ROOT",
            "cannot remove the document root",
            "path",
          );
        }
        return removeAt(current, op.path, 0, "path");
      case "replace":
        if (op.path.length === 0) {
          return op.value;
        }
        return replaceAt(current, op.path, 0, op.value, "path");
      case "move":
        return runMove(current, op);
      case "copy":
        return runCopy(current, op);
      case "test":
        return runTest(current, op);
    }
  } catch (error) {
    if (error instanceof StepError) {
      error.opIndex = index;
      error.opName = op.kind;
    }
    throw error;
  }
}

function runMove(
  current: JsonValue,
  op: Extract<ParsedOp, { kind: "move" }>,
): JsonValue {
  // RFC 6902 §4.4: moving the from-location into one of its own
  // descendants is impossible (it would need to vanish then reappear
  // inside itself), so reject before touching the document.
  if (isProperPrefix(op.from, op.path)) {
    throw new StepError(
      "MOVE_INTO_DESCENDANT",
      `cannot move "${formatPointer(op.from)}" into its own descendant "${formatPointer(op.path)}"`,
      "path",
    );
  }
  // Moving a node to its own location is a successful no-op (RFC A.13/A.14).
  if (samePointer(op.from, op.path)) {
    return current;
  }

  const value = resolveValue(current, op.from, "from");
  // Remove first, *then* resolve the target against the post-removal
  // document. This is what makes same-array moves follow the spec's
  // index-shift semantics (RFC A.18): /a/1 -> /a/2 on [A,B,C] yields
  // [A,C,B], not an invalid insertion.
  const withoutSource =
    op.from.length === 0
      ? undefined
      : removeAt(current, op.from, 0, "from");
  if (op.path.length === 0) {
    return value;
  }
  return addAt(
    withoutSource as JsonValue,
    op.path,
    0,
    value,
    "path",
  );
}

function runCopy(
  current: JsonValue,
  op: Extract<ParsedOp, { kind: "copy" }>,
): JsonValue {
  let value: JsonValue;
  try {
    // Deep clone: the copied subtree must not share any mutable container
    // with the source node.
    value = cloneJson(resolveValue(current, op.from, "from"));
  } catch (error) {
    if (error instanceof CyclicValueError) {
      throw new StepError(
        "CYCLIC_VALUE",
        error.message,
        "from",
        op.from.slice(0, -1),
        op.from[op.from.length - 1] ?? null,
      );
    }
    throw error;
  }
  if (op.path.length === 0) {
    return value;
  }
  return addAt(current, op.path, 0, value, "path");
}

function runTest(
  current: JsonValue,
  op: Extract<ParsedOp, { kind: "test" }>,
): JsonValue {
  const actual =
    op.path.length === 0 ? current : resolveValue(current, op.path, "path");
  const relativeDiff = firstDifference(actual, op.value);
  if (relativeDiff !== null) {
    throw new StepError(
      "TEST_FAILED",
      `test failed: value at "${formatPointer(op.path)}" differs from expected`,
      "path",
      op.path,
      null,
      formatPointer(op.path) + relativeDiff,
    );
  }
  return current;
}

/** True when `prefix` addresses an ancestor of `other` (not the same node). */
function isProperPrefix(prefix: PointerTokens, other: PointerTokens): boolean {
  if (prefix.length >= other.length) {
    return false;
  }
  for (let i = 0; i < prefix.length; i++) {
    if (prefix[i] !== other[i]) {
      return false;
    }
  }
  return true;
}

function samePointer(a: PointerTokens, b: PointerTokens): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Traversal
// ---------------------------------------------------------------------------

function resolveValue(
  doc: JsonValue,
  tokens: PointerTokens,
  field: "path" | "from",
): JsonValue {
  let node: JsonValue = doc;
  for (let depth = 0; depth < tokens.length; depth++) {
    const token = tokens[depth] as string;
    if (node === null || typeof node !== "object") {
      throw traverseError(node, token, tokens, depth, field);
    }
    if (Array.isArray(node)) {
      const index = arrayIndexFor(token);
      if (index === null || index >= node.length) {
        throw new StepError(
          "PATH_NOT_FOUND",
          `array has no element at index "${token}" (length ${node.length})`,
          field,
          tokens.slice(0, depth),
          token,
        );
      }
      node = node[index] as JsonValue;
    } else {
      if (!hasOwn(node, token)) {
        throw new StepError(
          "PATH_NOT_FOUND",
          `object has no member "${token}"`,
          field,
          tokens.slice(0, depth),
          token,
        );
      }
      node = node[token] as JsonValue;
    }
  }
  return node;
}

// ---------------------------------------------------------------------------
// Copy-on-write mutations. Each returns a new root; input nodes are never
// modified. Only nodes on the pointer's spine are shallow-copied.
// ---------------------------------------------------------------------------

function addAt(
  node: JsonValue,
  tokens: PointerTokens,
  depth: number,
  value: JsonValue,
  field: "path" | "from",
): JsonValue {
  const token = tokens[depth] as string;
  const isLast = depth === tokens.length - 1;

  if (node === null || typeof node !== "object") {
    throw traverseError(node, token, tokens, depth, field);
  }

  if (Array.isArray(node)) {
    if (isAppendToken(token)) {
      if (!isLast) {
        // "-" only names "one past the end"; there is no element to descend into.
        throw new StepError(
          "INVALID_ARRAY_INDEX",
          'append marker "-" cannot address an intermediate array element',
          field,
          tokens.slice(0, depth),
          token,
        );
      }
      const next = node.slice();
      next.push(value);
      return next;
    }

    const index = arrayIndexFor(token);
    if (index === null) {
      throw new StepError(
        "INVALID_ARRAY_INDEX",
        `"${token}" is not a valid array index`,
        field,
        tokens.slice(0, depth),
        token,
      );
    }
    if (!isLast) {
      if (index >= node.length) {
        throw new StepError(
          "PATH_NOT_FOUND",
          `array has no element at index "${token}" (length ${node.length})`,
          field,
          tokens.slice(0, depth),
          token,
        );
      }
      const next = node.slice();
      next[index] = addAt(
        node[index] as JsonValue,
        tokens,
        depth + 1,
        value,
        field,
      );
      return next;
    }
    // Final token: insertion. index === length appends; greater is an error.
    if (index > node.length) {
      throw new StepError(
        "INDEX_OUT_OF_BOUNDS",
        `cannot add at index ${index} of array with length ${node.length}`,
        field,
        tokens.slice(0, depth),
        token,
      );
    }
    const next = node.slice();
    next.splice(index, 0, value);
    return next;
  }

  // Object container: "-" is an ordinary member name, not an append marker.
  if (!isLast && !hasOwn(node, token)) {
    throw new StepError(
      "PATH_NOT_FOUND",
      `object has no member "${token}"`,
      field,
      tokens.slice(0, depth),
      token,
    );
  }
  if (!isLast) {
    return {
      ...node,
      [token]: addAt(
        node[token] as JsonValue,
        tokens,
        depth + 1,
        value,
        field,
      ),
    };
  }
  return { ...node, [token]: value };
}

function removeAt(
  node: JsonValue,
  tokens: PointerTokens,
  depth: number,
  field: "path" | "from",
): JsonValue {
  const token = tokens[depth] as string;
  const isLast = depth === tokens.length - 1;

  if (node === null || typeof node !== "object") {
    throw traverseError(node, token, tokens, depth, field);
  }

  if (Array.isArray(node)) {
    const index = arrayIndexFor(token);
    if (index === null) {
      throw new StepError(
        "INVALID_ARRAY_INDEX",
        isAppendToken(token)
          ? 'cannot remove the append marker "-"'
          : `"${token}" is not a valid array index`,
        field,
        tokens.slice(0, depth),
        token,
      );
    }
    if (index >= node.length) {
      throw new StepError(
        "INDEX_OUT_OF_BOUNDS",
        `cannot remove index ${index} from array with length ${node.length}`,
        field,
        tokens.slice(0, depth),
        token,
      );
    }
    if (!isLast) {
      const next = node.slice();
      next[index] = removeAt(
        node[index] as JsonValue,
        tokens,
        depth + 1,
        field,
      );
      return next;
    }
    const next = node.slice();
    next.splice(index, 1);
    return next;
  }

  if (!hasOwn(node, token)) {
    throw new StepError(
      "PATH_NOT_FOUND",
      `object has no member "${token}"`,
      field,
      tokens.slice(0, depth),
      token,
    );
  }
  if (!isLast) {
    return {
      ...node,
      [token]: removeAt(node[token] as JsonValue, tokens, depth + 1, field),
    };
  }
  const next: JsonObject = { ...node };
  delete next[token];
  return next;
}

function replaceAt(
  node: JsonValue,
  tokens: PointerTokens,
  depth: number,
  value: JsonValue,
  field: "path" | "from",
): JsonValue {
  const token = tokens[depth] as string;
  const isLast = depth === tokens.length - 1;

  if (node === null || typeof node !== "object") {
    throw traverseError(node, token, tokens, depth, field);
  }

  if (Array.isArray(node)) {
    const index = arrayIndexFor(token);
    if (index === null) {
      throw new StepError(
        "INVALID_ARRAY_INDEX",
        isAppendToken(token)
          ? 'cannot replace the append marker "-"'
          : `"${token}" is not a valid array index`,
        field,
        tokens.slice(0, depth),
        token,
      );
    }
    if (index >= node.length) {
      throw new StepError(
        "INDEX_OUT_OF_BOUNDS",
        `cannot replace index ${index} in array with length ${node.length}`,
        field,
        tokens.slice(0, depth),
        token,
      );
    }
    if (!isLast) {
      const next = node.slice();
      next[index] = replaceAt(
        node[index] as JsonValue,
        tokens,
        depth + 1,
        value,
        field,
      );
      return next;
    }
    const next = node.slice();
    next[index] = value;
    return next;
  }

  if (!hasOwn(node, token)) {
    throw new StepError(
      "PATH_NOT_FOUND",
      `cannot replace missing member "${token}"`,
      field,
      tokens.slice(0, depth),
      token,
    );
  }
  if (!isLast) {
    return {
      ...node,
      [token]: replaceAt(
        node[token] as JsonValue,
        tokens,
        depth + 1,
        value,
        field,
      ),
    };
  }
  return { ...node, [token]: value };
}

/**
 * Parse a token as an array index. Returns `null` for the append marker,
 * syntactically invalid tokens, and leading-zero forms.
 */
function arrayIndexFor(token: string): number | null {
  if (isAppendToken(token)) {
    return null;
  }
  return parseArrayIndex(token);
}

function traverseError(
  node: JsonValue,
  token: string,
  tokens: PointerTokens,
  depth: number,
  field: "path" | "from",
): StepError {
  return new StepError(
    "TYPE_MISMATCH",
    `cannot traverse through ${describeType(node)} with token "${token}"`,
    field,
    tokens.slice(0, depth),
    token,
  );
}

function describeType(value: JsonValue): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function hasOwn(node: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(node, key);
}

// ---------------------------------------------------------------------------
// Result assembly
// ---------------------------------------------------------------------------

function failure<T extends JsonValue>(
  doc: T,
  error: OpError,
): ApplyResult<T> {
  return { doc, ok: false, errors: [error] };
}

function toOpError(error: StepError): OpError {
  return {
    index: error.opIndex,
    op: error.opName,
    code: error.code,
    message: error.message,
    pointerField: error.pointerField,
    resolvedPath: formatPointer(error.resolvedTokens),
    failedToken: error.failedToken,
    ...(error.mismatchPath !== undefined
      ? { mismatchPath: error.mismatchPath }
      : {}),
  };
}
