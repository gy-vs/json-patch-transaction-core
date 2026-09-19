/**
 * 公共类型：JSON 值、RFC 6902 操作、结构化错误与 apply 结果。
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonContainer = JsonValue[] | { [key: string]: JsonValue };

export type PatchOpName = 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test';

interface BaseOp {
  op: PatchOpName;
}

export interface AddOp extends BaseOp {
  op: 'add';
  path: string;
  value: JsonValue;
}

export interface RemoveOp extends BaseOp {
  op: 'remove';
  path: string;
}

export interface ReplaceOp extends BaseOp {
  op: 'replace';
  path: string;
  value: JsonValue;
}

export interface MoveOp extends BaseOp {
  op: 'move';
  from: string;
  path: string;
}

export interface CopyOp extends BaseOp {
  op: 'copy';
  from: string;
  path: string;
}

export interface TestOp extends BaseOp {
  op: 'test';
  path: string;
  value: JsonValue;
}

export type PatchOperation = AddOp | RemoveOp | ReplaceOp | MoveOp | CopyOp | TestOp;

/**
 * 失败原因。前半段是 RFC 6901/6902 定义的语义错误，后半段是输入结构错误。
 */
export type PatchErrorCode =
  | 'POINTER_SYNTAX'
  | 'INVALID_ARRAY_INDEX'
  | 'OUT_OF_RANGE'
  | 'PATH_NOT_FOUND'
  | 'TYPE_MISMATCH'
  | 'ROOT_NOT_REMOVABLE'
  | 'MOVE_INTO_SELF'
  | 'TEST_FAILED'
  | 'MALFORMED_PATCH'
  | 'MALFORMED_OP'
  | 'UNSUPPORTED_TYPE';

/** 操作内部出错的字段位置（静态校验时使用）。 */
export type OpField = 'op' | 'path' | 'from' | 'value';

/**
 * 单条结构化错误。
 *
 * - 静态结构错误：opIndex 指向出错的操作下标，field 标明错误字段，pointer 为空。
 * - 路径语义错误：opIndex 为失败步骤下标，pointer 是失败涉及的 JSON Pointer；
 *   tokenIndex 是首个无法解析的 reference token 下标（0 起）。
 * - test 失败：mismatchPointer 为相对 path 的、首个不一致节点的位置；
 *   expected/actual 携带期望值与实际值（来自内部工作副本）。
 */
export interface PatchError {
  opIndex: number;
  code: PatchErrorCode;
  message: string;
  field?: OpField;
  pointer?: string;
  tokenIndex?: number;
  mismatchPointer?: string;
  expected?: JsonValue;
  actual?: JsonValue;
}

export interface ApplySuccess {
  ok: true;
  doc: JsonValue;
  errors: [];
}

export interface ApplyFailure {
  ok: false;
  /** 失败时原样返回调用者传入的文档（同一引用）。 */
  doc: JsonValue;
  errors: PatchError[];
}

export type ApplyResult = ApplySuccess | ApplyFailure;
