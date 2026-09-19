import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyPatch } from '../src/patch.js';
import type { JsonValue, PatchOperation } from '../src/types.js';

const original = {
  list: [1, 2, 3],
  nested: { a: { b: 'keep' }, untouched: [10, 20] },
  meta: { v: 1 },
};

function snapshot(): JsonValue {
  return structuredClone(original);
}

describe('原子性：失败不修改调用者文档，不留下部分结果', () => {
  it('第三步失败时，前两步的效果全部丢弃', () => {
    const doc = snapshot();
    const ops: PatchOperation[] = [
      { op: 'add', path: '/list/-', value: 4 },
      { op: 'replace', path: '/meta/v', value: 2 },
      { op: 'remove', path: '/nested/missing' }, // 不存在 -> 失败
    ];
    const r = applyPatch(doc, ops);
    assert.equal(r.ok, false);
    assert.deepEqual(doc, original, '原始文档必须与调用前完全一致');
    if (!r.ok) {
      assert.equal(r.doc, doc, '失败结果里的 doc 必须是入参引用本身');
      assert.equal(r.errors[0]!.opIndex, 2);
      assert.equal(r.errors[0]!.code, 'PATH_NOT_FOUND');
    }
  });

  it('move 到自身内部时回滚（即使没有前序操作也验证引用不变）', () => {
    const doc = snapshot();
    const r = applyPatch(doc, [{ op: 'move', from: '/nested', path: '/nested/a/inside' }]);
    assert.equal(r.ok, false);
    assert.deepEqual(doc, original);
    if (!r.ok) assert.equal(r.errors[0]!.code, 'MOVE_INTO_SELF');
  });

  it('同数组 move 之后 test 失败：移动结果一并回滚', () => {
    const doc = snapshot();
    const ops: PatchOperation[] = [
      { op: 'move', from: '/list/0', path: '/list/2' },
      { op: 'test', path: '/list', value: [2, 3, 1, 'extra'] }, // 长度不同 -> 失败
    ];
    const r = applyPatch(doc, ops);
    assert.equal(r.ok, false);
    assert.deepEqual(doc, original);
    if (!r.ok) {
      assert.equal(r.errors[0]!.opIndex, 1);
      assert.equal(r.errors[0]!.code, 'TEST_FAILED');
    }
  });

  it('copy 后 replace 失败：副本与替换全部丢弃', () => {
    const doc = snapshot();
    const ops: PatchOperation[] = [
      { op: 'copy', from: '/nested/a', path: '/nested/aCopy' },
      { op: 'replace', path: '/nested/no-such', value: 1 },
    ];
    const r = applyPatch(doc, ops);
    assert.equal(r.ok, false);
    assert.deepEqual(doc, original);
  });

  it('数组越界 add 回滚', () => {
    const doc = snapshot();
    const r = applyPatch(doc, [
      { op: 'add', path: '/list/0', value: 99 },
      { op: 'add', path: '/list/99', value: 100 },
    ]);
    assert.equal(r.ok, false);
    assert.deepEqual(doc, original);
  });

  it('remove 根失败不产生任何修改', () => {
    const doc = snapshot();
    const r = applyPatch(doc, [
      { op: 'add', path: '/list/-', value: 4 },
      { op: 'remove', path: '' },
    ]);
    assert.equal(r.ok, false);
    assert.deepEqual(doc, original);
  });

  it('成功路径返回的是新文档，入参文档也保持不变', () => {
    const doc = snapshot();
    const r = applyPatch(doc, [{ op: 'add', path: '/list/-', value: 4 }]);
    assert.equal(r.ok, true);
    assert.deepEqual(doc, original, '入参文档不变');
    if (r.ok) {
      assert.notEqual(r.doc, doc);
      assert.deepEqual(r.doc, { ...original, list: [1, 2, 3, 4] });
    }
  });

  it('空操作序列也返回隔离副本', () => {
    const doc = snapshot();
    const r = applyPatch(doc, []);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.notEqual(r.doc, doc);
      assert.deepEqual(r.doc, doc);
    }
  });

  it('错误位置按步骤下标精确报告', () => {
    const doc = snapshot();
    const ops: PatchOperation[] = [
      { op: 'test', path: '/meta/v', value: 1 },
      { op: 'add', path: '/ok', value: true },
      { op: 'test', path: '/meta/v', value: 999 },
    ];
    const r = applyPatch(doc, ops);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.errors.length, 1);
      assert.equal(r.errors[0]!.opIndex, 2);
      assert.equal(r.errors[0]!.field, 'path');
    }
  });

  it('路径解析深入标量时报告 TYPE_MISMATCH 与 tokenIndex', () => {
    const doc = { a: 1 };
    const r = applyPatch(doc, [{ op: 'add', path: '/a/b', value: 1 }]);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.errors[0]!.code, 'TYPE_MISMATCH');
      assert.equal(r.errors[0]!.tokenIndex, 0);
      assert.equal(r.errors[0]!.pointer, '/a/b');
    }
  });
});

describe('静态校验：不执行任何操作即可报告全部结构错误', () => {
  it('补丁不是数组', () => {
    const r = applyPatch({}, { not: 'an array' } as unknown as PatchOperation[]);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.errors[0]!.code, 'MALFORMED_PATCH');
      assert.equal(r.errors[0]!.opIndex, -1);
    }
  });

  it('一次性收集多个错误：缺 value、错误 op、坏指针', () => {
    const badOps = [
      { op: 'add', path: '/a' }, // 缺 value
      { op: 'frobnicate', path: '/a' }, // 未知 op
      { op: 'remove', path: 'no-leading-slash' }, // 坏指针
      42, // 不是对象
      { op: 'move', from: 5, path: '/x' }, // from 非字符串
    ];
    const r = applyPatch({ a: 1 }, badOps as unknown as PatchOperation[]);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.errors.length, 5);
      assert.deepEqual(
        r.errors.map((e) => e.code),
        ['MALFORMED_OP', 'MALFORMED_OP', 'POINTER_SYNTAX', 'MALFORMED_OP', 'MALFORMED_OP'],
      );
      assert.equal(r.errors[0]!.field, 'value');
      assert.equal(r.errors[1]!.field, 'op');
      assert.equal(r.errors[2]!.field, 'path');
      assert.equal(r.errors[4]!.field, 'from');
    }
  });

  it('静态错误时不触碰文档，且返回同一引用', () => {
    const doc = { a: 1 };
    const r = applyPatch(doc, [{ op: 'add' } as unknown as PatchOperation]);
    assert.equal(r.ok, false);
    assert.deepEqual(doc, { a: 1 });
    if (!r.ok) assert.equal(r.doc, doc);
  });

  it('指针中的非法转义属于静态错误', () => {
    const r = applyPatch({}, [{ op: 'remove', path: '/a~2b' }]);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.errors[0]!.code, 'POINTER_SYNTAX');
  });
});
