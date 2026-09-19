/**
 * 结构化深拷贝。
 *
 * 不使用 JSON.parse(JSON.stringify(...))：JSON 序列化会改变 NaN/Infinity 等数值
 * 语义，且大文档下性能特征不可控。这里用显式栈迭代拷贝，嵌套深度不会压垮调用栈。
 *
 * 输入约定为 JSON 值（对象字面量 / 数组 / 基本类型 / null）。
 * undefined、函数、符号等非 JSON 值出现在对象字段中时抛出 UnsupportedTypeError。
 * 环引用或共享引用也会抛出该错误（JSON 值本身是无环树）。
 */

import type { JsonValue } from './types.js';

export class UnsupportedTypeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedTypeError';
  }
}

interface Frame {
  source: object;
  target: object;
}

export function deepClone<T extends JsonValue>(value: T): T {
  if (value === null || typeof value !== 'object') {
    return value;
  }

  const root: JsonValue = Array.isArray(value)
    ? new Array<JsonValue>(value.length)
    : {};
  const seen = new Map<object, object>([[value, root]]);
  const stack: Frame[] = [{ source: value, target: root }];

  while (stack.length > 0) {
    const frame = stack.pop() as Frame;

    if (Array.isArray(frame.source)) {
      const src = frame.source as JsonValue[];
      const dst = frame.target as JsonValue[];
      for (let i = 0; i < src.length; i++) {
        dst[i] = cloneChild(src[i] as JsonValue, seen, stack);
      }
    } else {
      const src = frame.source as { [key: string]: JsonValue };
      const dst = frame.target as { [key: string]: JsonValue };
      for (const key of Object.keys(src)) {
        dst[key] = cloneChild(src[key] as JsonValue, seen, stack);
      }
    }
  }

  return root as T;
}

function cloneChild(
  child: JsonValue,
  seen: Map<object, object>,
  stack: Frame[],
): JsonValue {
  if (child === null || typeof child !== 'object') {
    if (
      typeof child === 'number' ||
      typeof child === 'string' ||
      typeof child === 'boolean' ||
      child === null
    ) {
      return child;
    }
    throw new UnsupportedTypeError(
      '文档包含非 JSON 值（仅支持 number/string/boolean/null/数组/普通对象）',
    );
  }
  if (seen.has(child)) {
    throw new UnsupportedTypeError('文档包含环引用或共享引用，无法表示为 JSON');
  }
  const copy: JsonValue = Array.isArray(child)
    ? new Array<JsonValue>(child.length)
    : {};
  seen.set(child, copy);
  stack.push({ source: child, target: copy });
  return copy;
}
