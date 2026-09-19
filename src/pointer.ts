/**
 * JSON Pointer（RFC 6901）。
 *
 * 转义解码顺序固定为：先 `~1` -> `/`，再 `~0` -> `~`。
 * 数组下标 token 只接受 "0" 或无前导零的正整数；"-" 是末尾追加标记，
 * 仅在 add 语境合法，解析为索引时单独报 INVALID_ARRAY_INDEX。
 */

import type { JsonContainer, JsonValue } from './types.js';

export interface ParsedPointer {
  raw: string;
  tokens: string[];
}

export class PointerSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PointerSyntaxError';
  }
}

/** 校验并解析一个 JSON Pointer 字符串。空串表示整个文档（根）。 */
export function parsePointer(pointer: string): ParsedPointer {
  if (typeof pointer !== 'string') {
    throw new PointerSyntaxError('JSON Pointer 必须是字符串');
  }
  if (pointer === '') {
    return { raw: '', tokens: [] };
  }
  if (!pointer.startsWith('/')) {
    throw new PointerSyntaxError('非根 JSON Pointer 必须以 "/" 开头');
  }
  // 开头的 "/" 产生一个空前缀，去掉它后按 "/" 切分。
  const tokens = pointer.slice(1).split('/').map(unescapeToken);
  return { raw: pointer, tokens };
}

/** RFC 6901 转义解码：顺序必须是 ~1 先于 ~0。 */
export function unescapeToken(token: string): string {
  let out: string[] | null = null;
  for (let i = 0; i < token.length; i++) {
    const ch = token[i];
    if (ch === '~') {
      if (out === null) out = token.slice(0, i).split('');
      const next = token[i + 1];
      if (next === '1') {
        out.push('/');
        i++;
      } else if (next === '0') {
        out.push('~');
        i++;
      } else {
        // 单独的 "~" 或 "~" 后接其它字符都是非法转义。
        throw new PointerSyntaxError(`非法转义序列: "~${next ?? ''}"`);
      }
    } else if (out !== null) {
      out.push(ch as string);
    }
  }
  return out === null ? token : out.join('');
}

/** RFC 6901 转义编码：先编码 "~"，再编码 "/"。 */
export function escapeToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** 把 token 序列序列化回 JSON Pointer。 */
export function formatPointer(tokens: readonly string[]): string {
  if (tokens.length === 0) return '';
  let out = '';
  for (const t of tokens) out += '/' + escapeToken(t);
  return out;
}

/**
 * 数组下标语法检查（不查边界）：
 * "0" 合法；非零首位不能带前导零。
 */
export function isArrayIndexToken(token: string): boolean {
  if (token === '0') return true;
  if (token.length === 0) return false;
  const first = token.charAt(0);
  if (first < '1' || first > '9') return false;
  for (let i = 1; i < token.length; i++) {
    const ch = token.charAt(i);
    if (ch < '0' || ch > '9') return false;
  }
  return true;
}

export interface ArrayIndex {
  index: number;
  append: boolean;
}

/**
 * 解析数组下标 token。
 * "-" 返回 { append: true }；非法语法抛出异常；越界由调用方按数组长度判断。
 */
export function parseArrayIndex(token: string): ArrayIndex {
  if (token === '-') return { index: -1, append: true };
  if (!isArrayIndexToken(token)) {
    throw new Error(`非法数组下标: "${token}"`);
  }
  return { index: Number(token), append: false };
}

export enum ResolveFailCode {
  NotFound = 'PATH_NOT_FOUND',
  TypeMismatch = 'TYPE_MISMATCH',
  OutOfRange = 'OUT_OF_RANGE',
  InvalidArrayIndex = 'INVALID_ARRAY_INDEX',
}

export interface ResolveFail {
  code: ResolveFailCode;
  /** 首个无法继续解析的 token 下标（相对于 tokens）。 */
  tokenIndex: number;
}

export type ResolveResult<T> =
  | { ok: true; value: T }
  | { ok: false; fail: ResolveFail };

function indexInto(container: JsonContainer, token: string, tokenIndex: number): ResolveResult<JsonValue> {
  if (Array.isArray(container)) {
    let parsed: ArrayIndex;
    try {
      parsed = parseArrayIndex(token);
    } catch {
      return { ok: false, fail: { code: ResolveFailCode.InvalidArrayIndex, tokenIndex } };
    }
    if (parsed.append) {
      return { ok: false, fail: { code: ResolveFailCode.InvalidArrayIndex, tokenIndex } };
    }
    if (parsed.index >= container.length) {
      return { ok: false, fail: { code: ResolveFailCode.OutOfRange, tokenIndex } };
    }
    return { ok: true, value: container[parsed.index] as JsonValue };
  }
  if (Object.prototype.hasOwnProperty.call(container, token)) {
    return { ok: true, value: (container as Record<string, JsonValue>)[token] as JsonValue };
  }
  return { ok: false, fail: { code: ResolveFailCode.NotFound, tokenIndex } };
}

/** 沿 tokens 取值；返回首个失败位置（成功时 tokenIndex 为 tokens.length）。 */
export function resolve(
  root: JsonValue,
  tokens: readonly string[],
): ResolveResult<JsonValue> {
  let current: JsonValue = root;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as string;
    if (current === null || typeof current !== 'object') {
      return { ok: false, fail: { code: ResolveFailCode.TypeMismatch, tokenIndex: i } };
    }
    const r = indexInto(current, token, i);
    if (!r.ok) return r;
    current = r.value;
  }
  return { ok: true, value: current };
}

export interface ContainerLocation {
  container: JsonContainer;
  /** 最后一段尚未解析的 reference token。 */
  lastToken: string;
}

/**
 * 解析到最后一个 token 的父容器。tokens 为空（根）时返回 null。
 * 调用方据此对容器做增删改（数组需自行解析 lastToken 为下标）。
 */
export function resolveParent(
  root: JsonValue,
  tokens: readonly string[],
): ResolveResult<ContainerLocation | null> {
  if (tokens.length === 0) return { ok: true, value: null };
  const parentTokens = tokens.slice(0, -1);
  const parentResult = resolve(root, parentTokens);
  if (!parentResult.ok) return parentResult;
  const parent = parentResult.value;
  if (parent === null || typeof parent !== 'object') {
    return { ok: false, fail: { code: ResolveFailCode.TypeMismatch, tokenIndex: parentTokens.length - 1 } };
  }
  return {
    ok: true,
    value: { container: parent, lastToken: tokens[tokens.length - 1] as string },
  };
}
