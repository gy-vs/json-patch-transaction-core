/**
 * json-patch-inmem：内存内、原子化的 RFC 6902 JSON Patch 库。
 *
 * @example
 * import { applyPatch } from './index.js';
 *
 * const result = applyPatch({ a: 1 }, [
 *   { op: 'add', path: '/b', value: 2 },
 *   { op: 'test', path: '/a', value: 1 },
 * ]);
 * if (result.ok) {
 *   // result.doc => { a: 1, b: 2 }
 * } else {
 *   // result.doc 与传入文档同一引用；result.errors 含结构化错误
 * }
 */

export { applyPatch, validateOperations } from './patch.js';
export { deepClone } from './clone.js';
export { deepEqual, firstDifference } from './equality.js';
export {
  parsePointer,
  unescapeToken,
  escapeToken,
  formatPointer,
  isArrayIndexToken,
  PointerSyntaxError,
} from './pointer.js';
export type {
  AddOp,
  RemoveOp,
  ReplaceOp,
  MoveOp,
  CopyOp,
  TestOp,
  PatchOperation,
  PatchOpName,
  PatchError,
  PatchErrorCode,
  ApplyResult,
  ApplySuccess,
  ApplyFailure,
  JsonValue,
  JsonContainer,
} from './types.js';
