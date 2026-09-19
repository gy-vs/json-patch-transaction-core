/**
 * RFC 6902 test 用的深度相等比较。
 *
 * 数值按 SameValue 比较（Object.is）：因此 NaN 等于 NaN，+0 不等于 -0。
 * 比较是迭代式的，深层文档不会撑爆调用栈。返回值为首个差异位置的 token 序列
 * （已解码、未转义）；完全相等时返回 null。
 */

import type { JsonValue } from './types.js';

interface Frame {
  a: JsonValue;
  b: JsonValue;
  prefix: string[];
}

export function firstDifference(actual: JsonValue, expected: JsonValue): string[] | null {
  const stack: Frame[] = [{ a: actual, b: expected, prefix: [] }];

  while (stack.length > 0) {
    const { a, b, prefix } = stack.pop() as Frame;

    if (a === null || typeof a !== 'object') {
      if (!Object.is(a, b)) return prefix;
      continue;
    }
    if (b === null || typeof b !== 'object') return prefix;

    const aIsArray = Array.isArray(a);
    const bIsArray = Array.isArray(b);
    if (aIsArray !== bIsArray) return prefix;

    if (aIsArray) {
      const aa = a as JsonValue[];
      const bb = b as JsonValue[];
      if (aa.length !== bb.length) return prefix;
      // 逆序压栈，保证从下标 0 开始检查，差异位置确定。
      for (let i = aa.length - 1; i >= 0; i--) {
        stack.push({ a: aa[i] as JsonValue, b: bb[i] as JsonValue, prefix: [...prefix, String(i)] });
      }
    } else {
      const ao = a as { [key: string]: JsonValue };
      const bo = b as { [key: string]: JsonValue };
      const keys = Object.keys(ao);
      if (keys.length !== Object.keys(bo).length) return prefix;
      // 逆序压栈，迭代顺序与键插入顺序一致。
      for (let i = keys.length - 1; i >= 0; i--) {
        const key = keys[i] as string;
        if (!Object.prototype.hasOwnProperty.call(bo, key)) return prefix;
        stack.push({ a: ao[key] as JsonValue, b: bo[key] as JsonValue, prefix: [...prefix, key] });
      }
    }
  }

  return null;
}

export function deepEqual(a: JsonValue, b: JsonValue): boolean {
  return firstDifference(a, b) === null;
}
