/**
 * RFC 6902 JSON Patch 执行器。
 *
 * 原子性：applyPatch 先深拷贝输入文档，所有操作只作用于工作副本；
 * 任何一步失败即丢弃整个副本，调用者的原始文档保持字节不变，
 * 也不会留下前几步的部分结果。失败结果里的 doc 与传入引用相同。
 *
 * move 语义（RFC 4.3）：
 *   - from 是 path 的祖先时拒绝（MOVE_INTO_SELF）；from === path 为空操作。
 *   - 同一数组内移动按"先在原文档取出并移除，再按下标插入"执行：
 *     源元素移除后目标下标按缩小后的数组解释（即若 index(from) < index(path)，
 *     RFC 规定的等价语义下 path 下标减一，与参考示例一致）。
 *
 * copy 语义（RFC 4.5）：插入目标位置的是源值的深拷贝，不与源共享可变引用。
 */

import { deepClone, UnsupportedTypeError } from './clone.js';
import { firstDifference } from './equality.js';
import {
  formatPointer,
  parsePointer,
  PointerSyntaxError,
  resolve,
  resolveParent,
  parseArrayIndex,
  ResolveFailCode,
  type ContainerLocation,
} from './pointer.js';
import type {
  ApplyResult,
  JsonValue,
  OpField,
  PatchError,
  PatchErrorCode,
  PatchOperation,
} from './types.js';

class ApplyAbort extends Error {
  constructor(readonly error: PatchError) {
    super(error.message);
    this.name = 'ApplyAbort';
  }
}

function err(
  opIndex: number,
  code: PatchErrorCode,
  message: string,
  extra?: Partial<PatchError>,
): PatchError {
  return { opIndex, code, message, ...extra };
}

function failPointer(rawPointer: string): string {
  return rawPointer === '' ? '(root)' : rawPointer;
}

// ---------------------------------------------------------------------------
// 静态校验：结构、字段、指针语法。不触碰文档，因此可以一次收集全部错误。
// ---------------------------------------------------------------------------

function checkPointerField(
  opIndex: number,
  pointer: unknown,
  field: OpField,
  errors: PatchError[],
): void {
  if (typeof pointer !== 'string') {
    errors.push(
      err(
        opIndex,
        'MALFORMED_OP',
        `操作 #${opIndex} 的 "${field}" 字段必须是字符串`,
        { field },
      ),
    );
    return;
  }
  try {
    parsePointer(pointer);
  } catch (e) {
    if (e instanceof PointerSyntaxError) {
      errors.push(
        err(
          opIndex,
          'POINTER_SYNTAX',
          `操作 #${opIndex} 的 "${field}" 不是合法 JSON Pointer: ${e.message}`,
          { field, pointer },
        ),
      );
    } else {
      throw e;
    }
  }
}

/**
 * 校验操作序列本身（不依赖文档）。返回所有结构/语法错误。
 * 数组下标的边界与存在性属于运行时语义，在执行阶段检查。
 */
export function validateOperations(operations: unknown): PatchError[] {
  const errors: PatchError[] = [];
  if (!Array.isArray(operations)) {
    errors.push(err(-1, 'MALFORMED_PATCH', '补丁必须是操作对象组成的数组'));
    return errors;
  }

  operations.forEach((raw, i) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push(err(i, 'MALFORMED_OP', `操作 #${i} 必须是对象`));
      return;
    }
    const op = (raw as { op?: unknown }).op;
    if (typeof op !== 'string') {
      errors.push(err(i, 'MALFORMED_OP', `操作 #${i} 缺少字符串类型的 "op" 字段`, { field: 'op' }));
      return;
    }

    const obj = raw as Record<string, unknown>;

    switch (op) {
      case 'add':
      case 'replace':
      case 'test': {
        if (!('value' in obj)) {
          errors.push(err(i, 'MALFORMED_OP', `操作 #${i} ("${op}") 缺少 "value" 字段`, { field: 'value' }));
        }
        checkPointerField(i, obj.path, 'path', errors);
        break;
      }
      case 'remove': {
        checkPointerField(i, obj.path, 'path', errors);
        break;
      }
      case 'move':
      case 'copy': {
        checkPointerField(i, obj.from, 'from', errors);
        checkPointerField(i, obj.path, 'path', errors);
        break;
      }
      default: {
        errors.push(
          err(
            i,
            'MALFORMED_OP',
            `操作 #${i} 的 op "${op as string}" 不受支持（允许 add/remove/replace/move/copy/test）`,
            { field: 'op' },
          ),
        );
      }
    }
  });

  return errors;
}

// ---------------------------------------------------------------------------
// 运行时：在工作副本上执行单个操作。失败统一抛 ApplyAbort（携带结构化错误）。
// ---------------------------------------------------------------------------

interface OpContext {
  index: number;
  field: OpField;
  rawPointer: string;
}

function mapResolveFailure(
  ctx: OpContext,
  code: ResolveFailCode,
  tokenIndex: number,
): PatchError {
  const mapped: PatchErrorCode =
    code === ResolveFailCode.NotFound
      ? 'PATH_NOT_FOUND'
      : code === ResolveFailCode.TypeMismatch
        ? 'TYPE_MISMATCH'
        : code === ResolveFailCode.OutOfRange
          ? 'OUT_OF_RANGE'
          : 'INVALID_ARRAY_INDEX';
  return err(
    ctx.index,
    mapped,
    describeResolveFailure(mapped, ctx.rawPointer, tokenIndex),
    { pointer: ctx.rawPointer, tokenIndex, field: ctx.field },
  );
}

function describeResolveFailure(code: PatchErrorCode, pointer: string, tokenIndex: number): string {
  const at = failPointer(pointer);
  switch (code) {
    case 'PATH_NOT_FOUND':
      return `路径 ${at} 的第 ${tokenIndex} 个 token 在对象中不存在`;
    case 'TYPE_MISMATCH':
      return `路径 ${at} 的第 ${tokenIndex} 个 token 需要对象或数组，但实际值不是容器`;
    case 'OUT_OF_RANGE':
      return `路径 ${at} 的第 ${tokenIndex} 个 token 超出数组边界`;
    case 'INVALID_ARRAY_INDEX':
      return `路径 ${at} 的第 ${tokenIndex} 个 token 不是合法数组下标（"0" 或无前导零的非负整数）`;
    default:
      return `路径 ${at} 无法解析`;
  }
}

function resolveValueOrAbort(doc: JsonValue, pointer: string, ctx: OpContext): JsonValue {
  const parsed = parsePointer(pointer);
  const result = resolve(doc, parsed.tokens);
  if (!result.ok) {
    throw new ApplyAbort(mapResolveFailure(ctx, result.fail.code, result.fail.tokenIndex));
  }
  return result.value;
}

function resolveParentOrAbort(doc: JsonValue, pointer: string, ctx: OpContext): ContainerLocation | null {
  const parsed = parsePointer(pointer);
  const result = resolveParent(doc, parsed.tokens);
  if (!result.ok) {
    throw new ApplyAbort(mapResolveFailure(ctx, result.fail.code, result.fail.tokenIndex));
  }
  return result.value;
}

/** RFC 4.1 add。数组下标插入（"-" 为末尾追加），对象键新增/覆盖。 */
function doAdd(doc: JsonValue, pointer: string, value: JsonValue, ctx: OpContext): JsonValue {
  if (pointer === '') return value;

  const tokens = parsePointer(pointer).tokens;
  const result = resolveParent(doc, tokens);
  if (!result.ok) {
    throw new ApplyAbort(mapResolveFailure(ctx, result.fail.code, result.fail.tokenIndex));
  }
  const loc = result.value;
  if (loc === null) return value;
  const { container, lastToken } = loc;
  const tokenIndex = tokens.length - 1;

  if (Array.isArray(container)) {
    let parsed;
    try {
      parsed = parseArrayIndex(lastToken);
    } catch {
      throw new ApplyAbort(
        err(
          ctx.index,
          'INVALID_ARRAY_INDEX',
          `add 路径含非法数组下标: "${lastToken}"`,
          { pointer: ctx.rawPointer, tokenIndex, field: 'path' },
        ),
      );
    }
    if (parsed.append) {
      container.push(value);
    } else {
      if (parsed.index > container.length) {
        throw new ApplyAbort(
          err(
            ctx.index,
            'OUT_OF_RANGE',
            `add 下标 ${parsed.index} 超出数组边界（长度 ${container.length}，合法插入位置 0..${container.length}）`,
            { pointer: ctx.rawPointer, tokenIndex, field: 'path' },
          ),
        );
      }
      container.splice(parsed.index, 0, value);
    }
  } else {
    (container as Record<string, JsonValue>)[lastToken] = value;
  }
  return doc;
}

/** RFC 4.2 remove。根路径不可删除。 */
function doRemove(doc: JsonValue, pointer: string, ctx: OpContext): { doc: JsonValue; removed: JsonValue } {
  if (pointer === '') {
    throw new ApplyAbort(
      err(ctx.index, 'ROOT_NOT_REMOVABLE', '不能 remove 根文档（路径为空）', {
        pointer: '',
        field: 'path',
      }),
    );
  }

  const parsed = parsePointer(pointer);
  const loc = resolveParentOrAbort(doc, pointer, ctx);
  if (loc === null) {
    throw new ApplyAbort(err(ctx.index, 'ROOT_NOT_REMOVABLE', '不能 remove 根文档', { field: 'path' }));
  }
  const { container, lastToken } = loc;
  const tokenIndex = parsed.tokens.length - 1;

  if (Array.isArray(container)) {
    let parsedIndex;
    try {
      parsedIndex = parseArrayIndex(lastToken);
    } catch {
      throw new ApplyAbort(
        err(
          ctx.index,
          'INVALID_ARRAY_INDEX',
          `remove 路径含非法数组下标: "${lastToken}"`,
          { pointer: ctx.rawPointer, tokenIndex, field: 'path' },
        ),
      );
    }
    if (parsedIndex.append || parsedIndex.index >= container.length) {
      throw new ApplyAbort(
        err(
          ctx.index,
          'OUT_OF_RANGE',
          `remove 下标 ${lastToken} 超出数组边界（长度 ${container.length}）`,
          { pointer: ctx.rawPointer, tokenIndex, field: 'path' },
        ),
      );
    }
    const removed = container.splice(parsedIndex.index, 1)[0] as JsonValue;
    return { doc, removed };
  }

  if (!Object.prototype.hasOwnProperty.call(container, lastToken)) {
    throw new ApplyAbort(
      err(
        ctx.index,
        'PATH_NOT_FOUND',
        `对象上不存在键 "${lastToken}"，无法 remove`,
        { pointer: ctx.rawPointer, tokenIndex, field: 'path' },
      ),
    );
  }
  const removed = (container as Record<string, JsonValue>)[lastToken] as JsonValue;
  delete (container as Record<string, JsonValue>)[lastToken];
  return { doc, removed };
}

/** RFC 4.4 replace。目标位置必须已存在；根替换为整个文档。 */
function doReplace(doc: JsonValue, pointer: string, value: JsonValue, ctx: OpContext): JsonValue {
  if (pointer === '') return value;

  const parsed = parsePointer(pointer);
  // 目标必须存在：resolve 整个路径，再落盘到父容器。
  const existence = resolve(doc, parsed.tokens);
  if (!existence.ok) {
    throw new ApplyAbort(mapResolveFailure(ctx, existence.fail.code, existence.fail.tokenIndex));
  }

  const loc = resolveParentOrAbort(doc, pointer, ctx);
  if (loc === null) return value;
  const { container, lastToken } = loc;

  if (Array.isArray(container)) {
    let parsedIndex;
    try {
      parsedIndex = parseArrayIndex(lastToken);
    } catch {
      throw new ApplyAbort(
        err(
          ctx.index,
          'INVALID_ARRAY_INDEX',
          `replace 路径含非法数组下标: "${lastToken}"`,
          { pointer: ctx.rawPointer, tokenIndex: parsed.tokens.length - 1, field: 'path' },
        ),
      );
    }
    if (parsedIndex.append) {
      throw new ApplyAbort(
        err(
          ctx.index,
          'INVALID_ARRAY_INDEX',
          'replace 不能使用末尾追加标记 "-"（目标元素必须已存在）',
          { pointer: ctx.rawPointer, tokenIndex: parsed.tokens.length - 1, field: 'path' },
        ),
      );
    }
    if (parsedIndex.index >= container.length) {
      throw new ApplyAbort(
        err(
          ctx.index,
          'OUT_OF_RANGE',
          `replace 下标 ${parsedIndex.index} 超出数组边界（长度 ${container.length}）`,
          { pointer: ctx.rawPointer, tokenIndex: parsed.tokens.length - 1, field: 'path' },
        ),
      );
    }
    container[parsedIndex.index] = value;
  } else {
    (container as Record<string, JsonValue>)[lastToken] = value;
  }
  return doc;
}

/** RFC 4.3 move。 */
function doMove(doc: JsonValue, from: string, path: string, opIndex: number): JsonValue {
  if (from === path) return doc; // 移动到自身：成功的空操作

  const fromTokens = parsePointer(from).tokens;
  const pathTokens = parsePointer(path).tokens;

  // from 是 path 的正确前缀 => 目标位于源节点内部，拒绝。
  if (isProperPrefix(fromTokens, pathTokens)) {
    throw new ApplyAbort(
      err(
        opIndex,
        'MOVE_INTO_SELF',
        `move 目标路径 "${failPointer(path)}" 位于源路径 "${failPointer(from)}" 内部`,
        { pointer: path, field: 'path' },
      ),
    );
  }

  // 先在原工作副本上定位并取出源值（get + remove 语义）。
  const getCtx: OpContext = { index: opIndex, field: 'from', rawPointer: from };
  resolveValueOrAbort(doc, from, getCtx); // 仅为产生规范的源路径错误
  const { removed } = doRemove(doc, from, getCtx);

  // 源已从副本移除，removed 是一棵脱离文档的子树；直接插入即可。
  const addCtx: OpContext = { index: opIndex, field: 'path', rawPointer: path };
  return doAdd(doc, path, removed, addCtx);
}

/** RFC 4.5 copy：源值深拷贝后插入，不共享任何可变引用。 */
function doCopy(doc: JsonValue, from: string, path: string, opIndex: number): JsonValue {
  const getCtx: OpContext = { index: opIndex, field: 'from', rawPointer: from };
  const source = resolveValueOrAbort(doc, from, getCtx);
  const detached = deepClone(source);
  const addCtx: OpContext = { index: opIndex, field: 'path', rawPointer: path };
  return doAdd(doc, path, detached, addCtx);
}

/** RFC 4.6 test。 */
function doTest(doc: JsonValue, path: string, expected: JsonValue, opIndex: number): void {
  const ctx: OpContext = { index: opIndex, field: 'path', rawPointer: path };
  const actual = resolveValueOrAbort(doc, path, ctx);
  const diffTokens = firstDifference(actual, expected);
  if (diffTokens !== null) {
    const prefix = path === '' ? '' : path;
    const mismatchPointer = prefix + formatPointer(diffTokens);
    // 取出差异节点自身（叶子或类型不同的容器），便于调用方报告。
    const actualAtDiff = resolve(actual, diffTokens);
    const expectedAtDiff = resolve(expected, diffTokens);
    throw new ApplyAbort(
      err(opIndex, 'TEST_FAILED', `test 失败：值在 "${mismatchPointer}" 处与期望值不相同`, {
        pointer: path,
        field: 'path',
        mismatchPointer,
        expected: expectedAtDiff.ok ? expectedAtDiff.value : expected,
        actual: actualAtDiff.ok ? actualAtDiff.value : actual,
      }),
    );
  }
}

function isProperPrefix(prefix: readonly string[], path: readonly string[]): boolean {
  if (prefix.length >= path.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (prefix[i] !== path[i]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/**
 * 原子地把一组操作应用到文档。
 *
 * 成功：{ ok: true, doc: 新文档, errors: [] }，新文档与入参完全隔离
 * （入参文档与每个操作的 value 都经过深拷贝），且不经过 JSON 字符串化。
 * 失败：{ ok: false, doc: 原始文档引用, errors: [结构化错误] }，
 * 静态阶段可能返回多条错误；执行阶段在首个失败步骤中止，errors 恰有一条。
 */
export function applyPatch(doc: JsonValue, operations: readonly PatchOperation[]): ApplyResult {
  const staticErrors = validateOperations(operations);
  if (staticErrors.length > 0) {
    return { ok: false, doc, errors: staticErrors };
  }
  // 静态校验已通过，以下转换不会抛 PointerSyntaxError。
  const ops = operations as PatchOperation[];

  let working: JsonValue;
  try {
    working = deepClone(doc);
  } catch (e) {
    if (e instanceof UnsupportedTypeError) {
      return {
        ok: false,
        doc,
        errors: [err(-1, 'UNSUPPORTED_TYPE', e.message)],
      };
    }
    throw e;
  }

  try {
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i] as PatchOperation;
      switch (op.op) {
        case 'add':
          working = doAdd(working, op.path, deepClone(op.value), { index: i, field: 'path', rawPointer: op.path });
          break;
        case 'remove':
          working = doRemove(working, op.path, { index: i, field: 'path', rawPointer: op.path }).doc;
          break;
        case 'replace':
          working = doReplace(working, op.path, deepClone(op.value), { index: i, field: 'path', rawPointer: op.path });
          break;
        case 'move':
          working = doMove(working, op.from, op.path, i);
          break;
        case 'copy':
          working = doCopy(working, op.from, op.path, i);
          break;
        case 'test':
          doTest(working, op.path, op.value, i);
          break;
      }
    }
  } catch (e) {
    if (e instanceof ApplyAbort) {
      // 丢弃整份工作副本：入参文档从未被触碰。
      return { ok: false, doc, errors: [e.error] };
    }
    if (e instanceof UnsupportedTypeError) {
      return { ok: false, doc, errors: [err(-1, 'UNSUPPORTED_TYPE', e.message)] };
    }
    throw e;
  }

  return { ok: true, doc: working, errors: [] };
}
