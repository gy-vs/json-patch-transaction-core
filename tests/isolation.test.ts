import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyPatch, deepClone } from '../src/index.js';
import type { JsonValue, PatchOperation } from '../src/types.js';

describe('引用隔离', () => {
  it('copy 后的对象与源对象不共享任何可变引用', () => {
    const doc: JsonValue = {
      src: { nested: { arr: [1, { deep: true }] } },
    };
    const r = applyPatch(doc, [{ op: 'copy', from: '/src', path: '/dst' }]);
    assert.equal(r.ok, true);
    if (!r.ok) return;

    const out = r.doc as { src: { nested: { arr: JsonValue[] } }; dst: { nested: { arr: JsonValue[] } } };
    assert.notEqual(out.dst, out.src);
    assert.notEqual(out.dst.nested, out.src.nested);
    assert.notEqual(out.dst.nested.arr, out.src.nested.arr);
    assert.notEqual(out.dst.nested.arr[1], out.src.nested.arr[1]);

    // 修改副本里的结构，源完全不受影响（再 apply 一次确认独立性）
    (out.dst.nested.arr as JsonValue[]).push(999);
    assert.deepEqual(out.src.nested.arr, [1, { deep: true }]);
  });

  it('copy 数组元素不共享引用', () => {
    const doc: JsonValue = { items: [{ id: 1 }] };
    const r = applyPatch(doc, [
      { op: 'copy', from: '/items/0', path: '/items/-' },
      { op: 'copy', from: '/items/0', path: '/items/-' },
    ]);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    const items = (r.doc as { items: object[] }).items;
    assert.equal(items.length, 3);
    assert.notEqual(items[0], items[1]);
    assert.notEqual(items[1], items[2]);
    assert.notEqual(items[0], items[2]);
  });

  it('add/replace 的 value 被深拷贝：调用者后续修改 value 不影响结果文档', () => {
    const payload: JsonValue = { nested: { n: 1 } };
    const doc: JsonValue = {};
    const r = applyPatch(doc, [{ op: 'add', path: '/x', value: payload }]);
    assert.equal(r.ok, true);
    if (!r.ok) return;

    (payload.nested as { n: number }).n = 42;
    assert.deepEqual(r.doc, { x: { nested: { n: 1 } } });
    assert.notEqual((r.doc as { x: object }).x, payload);
  });

  it('返回文档与输入文档不共享可变节点引用', () => {
    const doc: JsonValue = { a: { b: [1, 2] }, keep: { v: 1 } };
    const r = applyPatch(doc, [{ op: 'add', path: '/c', value: 3 }]);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.notEqual((r.doc as { a: unknown }).a, (doc as { a: unknown }).a);
    assert.notEqual((r.doc as { keep: unknown }).keep, (doc as { keep: unknown }).keep);
  });

  it('move 不导致与输入文档共享引用', () => {
    const doc: JsonValue = { a: { b: 1 }, c: {} };
    const r = applyPatch(doc, [{ op: 'move', from: '/a', path: '/c/a' }]);
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(doc, { a: { b: 1 }, c: {} });
    assert.deepEqual(r.doc, { c: { a: { b: 1 } } });
    assert.notEqual(
      ((r.doc as { c: { a: object } }).c.a),
      ((doc as { a: object }).a),
    );
  });

  it('deepClone：基本类型原样返回', () => {
    assert.equal(deepClone(1), 1);
    assert.equal(deepClone('s'), 's');
    assert.equal(deepClone(true), true);
    assert.equal(deepClone(null), null);
  });

  it('deepClone：深层嵌套不共享引用且内容相等', () => {
    const v = { a: [1, 2, { b: [null, true, 'x'] }], c: 0 };
    const c = deepClone(v);
    assert.deepEqual(c, v);
    assert.notEqual(c, v);
    assert.notEqual(c.a, v.a);
    assert.notEqual(c.a[2], v.a[2]);
    assert.notEqual((c.a[2] as { b: unknown[] }).b, (v.a[2] as { b: unknown[] }).b);
  });

  it('deepClone：环引用被拒绝（JSON 不可能含环）', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    assert.throws(() => deepClone(cyclic as unknown as JsonValue));
  });
});

describe('不使用 JSON 字符串化', () => {
  it('成功路径全程不调用 JSON.stringify / JSON.parse', () => {
    const doc: JsonValue = {
      a: { b: [1, 2, { c: 'd' }] },
      n: NaN,
    };
    const ops: PatchOperation[] = [
      { op: 'test', path: '/a/b/2/c', value: 'd' },
      { op: 'copy', from: '/a', path: '/a2' },
      { op: 'add', path: '/a/b/-', value: 3 },
      { op: 'move', from: '/n', path: '/moved' },
      { op: 'replace', path: '/a2/b/0', value: 10 },
    ];

    const origStringify = JSON.stringify;
    const origParse = JSON.parse;
    JSON.stringify = (() => {
      throw new Error('成功路径不允许使用 JSON.stringify');
    }) as typeof JSON.stringify;
    JSON.parse = (() => {
      throw new Error('成功路径不允许使用 JSON.parse');
    }) as typeof JSON.parse;
    let r;
    try {
      r = applyPatch(doc, ops);
    } finally {
      JSON.stringify = origStringify;
      JSON.parse = origParse;
    }
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(Number.isNaN((r.doc as { moved: number }).moved), true, 'NaN 必须原样保留');
      assert.deepEqual((r.doc as { a: { b: number[] } }).a.b, [1, 2, { c: 'd' }, 3]);
    }
    // 入参文档同样未被修改
    assert.deepEqual(doc, { a: { b: [1, 2, { c: 'd' }] }, n: NaN });
  });
});

describe('大文档性能可预测', () => {
  it('对 5 万节点的文档执行一组操作，远低于宽松上限', () => {
    const size = 50_000;
    const items: JsonValue[] = [];
    for (let i = 0; i < size; i++) items.push({ id: i, tag: `t-${i}`, nums: [i, i + 1, i + 2] });
    const doc: JsonValue = { items, meta: { count: size } };

    const ops: PatchOperation[] = [
      { op: 'test', path: '/meta/count', value: size },
      { op: 'add', path: '/items/-', value: { id: size, tag: 'last', nums: [0, 0, 0] } },
      { op: 'replace', path: '/meta/count', value: size + 1 },
      { op: 'copy', from: '/items/0', path: '/items/-' },
      { op: 'move', from: '/items/1', path: '/items/-' },
    ];

    const start = performance.now();
    const r = applyPatch(doc, ops);
    const elapsedMs = performance.now() - start;

    assert.equal(r.ok, true, r.ok ? '' : JSON.stringify(r.errors));
    if (r.ok) {
      assert.equal((r.doc as { items: unknown[] }).items.length, size + 2);
      assert.deepEqual(doc, { items, meta: { count: size } }, '输入文档保持不变');
    }
    assert.ok(elapsedMs < 10_000, `大文档处理过慢: ${elapsedMs.toFixed(0)}ms`);
  });

  it('深层文档（深度 20000）迭代式拷贝不爆栈', () => {
    let doc: JsonValue = { leaf: 'deep' };
    for (let i = 0; i < 20_000; i++) doc = { d: doc };
    const r = applyPatch(doc, [{ op: 'add', path: '/extra', value: 1 }]);
    assert.equal(r.ok, true);
  });
});
