import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyPatch } from '../src/patch.js';
import type { JsonValue, PatchOperation } from '../src/types.js';

function apply(doc: JsonValue, ops: PatchOperation[]) {
  const result = applyPatch(doc, ops);
  if (!result.ok) {
    throw new assert.AssertionError({
      message: `expected success but got: ${JSON.stringify(result.errors, null, 2)}`,
    });
  }
  return result.doc;
}

describe('add', () => {
  it('对象上新增成员', () => {
    assert.deepEqual(apply({ foo: 'bar' }, [{ op: 'add', path: '/baz', value: 'qux' }]), {
      foo: 'bar',
      baz: 'qux',
    });
  });

  it('对象上覆盖已有成员', () => {
    assert.deepEqual(apply({ foo: 'bar' }, [{ op: 'add', path: '/foo', value: 'qux' }]), {
      foo: 'qux',
    });
  });

  it('数组中间插入（RFC 4.1 示例）', () => {
    assert.deepEqual(apply({ foo: ['bar', 'baz'] }, [{ op: 'add', path: '/foo/1', value: 'qux' }]), {
      foo: ['bar', 'qux', 'baz'],
    });
  });

  it('数组前置插入', () => {
    assert.deepEqual(apply(['a', 'b'], [{ op: 'add', path: '/0', value: 'z' }]), ['z', 'a', 'b']);
  });

  it('末尾追加标记 "-"', () => {
    assert.deepEqual(apply(['a', 'b'], [{ op: 'add', path: '/-', value: 'c' }]), ['a', 'b', 'c']);
  });

  it('空数组上 "-" 与 "/0" 等价', () => {
    assert.deepEqual(apply([], [{ op: 'add', path: '/-', value: 1 }]), [1]);
    assert.deepEqual(apply([], [{ op: 'add', path: '/0', value: 1 }]), [1]);
  });

  it('空路径替换整个文档', () => {
    assert.deepEqual(apply({ a: 1 }, [{ op: 'add', path: '', value: [1, 2] }]), [1, 2]);
  });

  it('插入位置等于数组长度（显式数字）追加到末尾', () => {
    assert.deepEqual(apply(['a'], [{ op: 'add', path: '/1', value: 'b' }]), ['a', 'b']);
  });

  it('插入位置超过数组长度失败', () => {
    const r = applyPatch(['a'], [{ op: 'add', path: '/5', value: 'b' }]);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.errors[0]!.code, 'OUT_OF_RANGE');
  });

  it('嵌套数组/对象混合路径', () => {
    const doc = { list: [{ tags: ['x'] }] };
    assert.deepEqual(
      apply(doc, [{ op: 'add', path: '/list/0/tags/-', value: 'y' }]),
      { list: [{ tags: ['x', 'y'] }] },
    );
  });

  it('通过波浪号转义路径访问真实键名', () => {
    const doc = { 'a/b': 1, 'c~d': { 'e/f': 2 } };
    assert.deepEqual(apply(doc, [{ op: 'add', path: '/a~1b', value: 10 }]), {
      'a/b': 10,
      'c~d': { 'e/f': 2 },
    });
    assert.deepEqual(apply(doc, [{ op: 'add', path: '/c~0d/e~1f', value: 20 }]), {
      'a/b': 1,
      'c~d': { 'e/f': 20 },
    });
  });

  it('键名恰好为 "-" 的对象按对象规则处理（不是追加标记）', () => {
    assert.deepEqual(apply({ '-': 1 } as JsonValue, [{ op: 'add', path: '/-', value: 2 }]), {
      '-': 2,
    });
  });
});

describe('remove', () => {
  it('RFC 4.2 示例', () => {
    assert.deepEqual(apply({ baz: 'qux', foo: 'bar' }, [{ op: 'remove', path: '/baz' }]), {
      foo: 'bar',
    });
  });

  it('数组元素移除后下标重排', () => {
    assert.deepEqual(apply(['a', 'b', 'c'], [{ op: 'remove', path: '/1' }]), ['a', 'c']);
  });

  it('不存在的对象键失败', () => {
    const r = applyPatch({ a: 1 }, [{ op: 'remove', path: '/b' }]);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.errors[0]!.code, 'PATH_NOT_FOUND');
      assert.equal(r.errors[0]!.pointer, '/b');
      assert.equal(r.errors[0]!.tokenIndex, 0);
    }
  });

  it('越界数组下标失败', () => {
    const r = applyPatch([1], [{ op: 'remove', path: '/3' }]);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.errors[0]!.code, 'OUT_OF_RANGE');
  });

  it('不能 remove 根', () => {
    const r = applyPatch({ a: 1 }, [{ op: 'remove', path: '' }]);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.errors[0]!.code, 'ROOT_NOT_REMOVABLE');
  });

  it('不能对数组使用 "-"', () => {
    const r = applyPatch([1, 2], [{ op: 'remove', path: '/-' }]);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.errors[0]!.code, 'OUT_OF_RANGE');
  });

  it('带前导零的下标非法', () => {
    const r = applyPatch([1, 2], [{ op: 'remove', path: '/01' }]);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.errors[0]!.code, 'INVALID_ARRAY_INDEX');
  });

  it('移除转义键', () => {
    assert.deepEqual(
      apply({ 'a/b': 1, keep: 2 } as JsonValue, [{ op: 'remove', path: '/a~1b' }]),
      { keep: 2 },
    );
  });
});

describe('replace', () => {
  it('RFC 4.4 示例', () => {
    assert.deepEqual(apply({ a: 'b' }, [{ op: 'replace', path: '/a', value: 'c' }]), { a: 'c' });
  });

  it('数组元素原地替换，长度不变', () => {
    assert.deepEqual(apply([1, 2, 3], [{ op: 'replace', path: '/1', value: 9 }]), [1, 9, 3]);
  });

  it('目标不存在时失败（不同于 add）', () => {
    const r = applyPatch({ a: 1 }, [{ op: 'replace', path: '/b', value: 2 }]);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.errors[0]!.code, 'PATH_NOT_FOUND');
  });

  it('replace "-" 非法（目标必须存在）', () => {
    const r = applyPatch([1], [{ op: 'replace', path: '/-', value: 2 }]);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.errors[0]!.code, 'INVALID_ARRAY_INDEX');
  });

  it('根替换', () => {
    assert.deepEqual(apply({ a: 1 }, [{ op: 'replace', path: '', value: null }]), null);
  });
});

describe('move', () => {
  it('RFC A.4 示例：对象成员重命名', () => {
    assert.deepEqual(
      apply(
        { foo: { bar: 'baz', waldo: 'fred' }, qux: { corge: 'grault' } },
        [{ op: 'move', from: '/foo/waldo', path: '/foo/qux' }],
      ),
      { foo: { bar: 'baz', qux: 'fred' }, qux: { corge: 'grault' } },
    );
  });

  it('同一数组内移动：RFC A.1 示例（从 1 移到 3）', () => {
    assert.deepEqual(
      apply(
        { foo: [1, 2, 3, 4], bars: ['a', 'b'] },
        [{ op: 'move', from: '/foo/1', path: '/foo/3' }],
      ),
      { foo: [1, 3, 4, 2], bars: ['a', 'b'] },
    );
  });

  it('同一数组内向后移动多个位置（先删后插，下标按缩小后的数组解释）', () => {
    // 删除下标 1 后数组 [1,3,4,5]，在 3 插入 => [1,3,4,2,5]
    assert.deepEqual(
      apply([1, 2, 3, 4, 5], [{ op: 'move', from: '/1', path: '/3' }]),
      [1, 3, 4, 2, 5],
    );
  });

  it('同一数组内向前移动', () => {
    assert.deepEqual(
      apply([1, 2, 3, 4, 5], [{ op: 'move', from: '/3', path: '/1' }]),
      [1, 4, 2, 3, 5],
    );
  });

  it('移动到末尾 "-"', () => {
    assert.deepEqual(apply([1, 2, 3], [{ op: 'move', from: '/0', path: '/-' }]), [2, 3, 1]);
  });

  it('移动到自身路径是空操作，且成功', () => {
    assert.deepEqual(
      apply([1, 2, 3], [{ op: 'move', from: '/1', path: '/1' }]),
      [1, 2, 3],
    );
  });

  it('目标位于源节点内部（直接子路径）必须拒绝', () => {
    const r = applyPatch(
      { a: { b: 1 } },
      [{ op: 'move', from: '/a', path: '/a/x' }],
    );
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.errors[0]!.code, 'MOVE_INTO_SELF');
      assert.equal(r.errors[0]!.opIndex, 0);
      assert.equal(r.errors[0]!.pointer, '/a/x');
    }
  });

  it('目标位于源节点内部（更深路径）必须拒绝', () => {
    const r = applyPatch(
      { list: [[1, 2]] },
      [{ op: 'move', from: '/list/0', path: '/list/0/2/x' }],
    );
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.errors[0]!.code, 'MOVE_INTO_SELF');
  });

  it('源路径不存在失败', () => {
    const r = applyPatch({ a: 1 }, [{ op: 'move', from: '/x', path: '/y' }]);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.errors[0]!.code, 'PATH_NOT_FOUND');
  });

  it('跨容器移动（数组 -> 对象）', () => {
    assert.deepEqual(
      apply({ arr: [1, 2, 3], obj: {} }, [{ op: 'move', from: '/arr/1', path: '/obj/taken' }]),
      { arr: [1, 3], obj: { taken: 2 } },
    );
  });

  it('move 整个根到内部路径被拒绝', () => {
    const r = applyPatch({ a: 1 }, [{ op: 'move', from: '', path: '/x' }]);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.errors[0]!.code, 'MOVE_INTO_SELF');
  });

  it('移动内部节点到根：等价替换', () => {
    assert.deepEqual(
      apply({ a: { b: 1 }, c: 2 }, [{ op: 'move', from: '/a', path: '' }]),
      { b: 1 },
    );
  });
});

describe('copy', () => {
  it('RFC A.5 示例风格：复制对象成员', () => {
    assert.deepEqual(
      apply({ foo: { x: 1 } }, [{ op: 'copy', from: '/foo', path: '/bar' }]),
      { foo: { x: 1 }, bar: { x: 1 } },
    );
  });

  it('复制数组元素到末尾', () => {
    assert.deepEqual(
      apply({ list: [{ n: 1 }, { n: 2 }] }, [{ op: 'copy', from: '/list/0', path: '/list/-' }]),
      { list: [{ n: 1 }, { n: 2 }, { n: 1 }] },
    );
  });

  it('复制深层节点', () => {
    assert.deepEqual(
      apply({ a: { b: [1, { c: 2 }] } }, [{ op: 'copy', from: '/a/b/1', path: '/d' }]),
      { a: { b: [1, { c: 2 }] }, d: { c: 2 } },
    );
  });

  it('复制不存在的源失败', () => {
    const r = applyPatch({ a: 1 }, [{ op: 'copy', from: '/z', path: '/a' }]);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.errors[0]!.code, 'PATH_NOT_FOUND');
  });
});

describe('test', () => {
  it('成功：整个文档相等（RFC A.6 示例风格）', () => {
    assert.deepEqual(
      apply(
        { foo: ['a', 'b'] },
        [{ op: 'test', path: '/foo', value: ['a', 'b'] }],
      ),
      { foo: ['a', 'b'] },
    );
  });

  it('成功：叶子值相等', () => {
    assert.deepEqual(
      apply({ n: 1, s: 'x', b: true, nil: null }, [
        { op: 'test', path: '/n', value: 1 },
        { op: 'test', path: '/s', value: 'x' },
        { op: 'test', path: '/b', value: true },
        { op: 'test', path: '/nil', value: null },
      ]),
      { n: 1, s: 'x', b: true, nil: null },
    );
  });

  it('失败：值不同，报 TEST_FAILED 与 mismatchPointer', () => {
    const r = applyPatch(
      { a: { b: 1, c: 2 } },
      [{ op: 'test', path: '/a', value: { b: 1, c: 9 } }],
    );
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.errors[0]!.code, 'TEST_FAILED');
      // mismatchPointer 是文档绝对指针：测试基准点 /a 下的 /c
      assert.equal(r.errors[0]!.mismatchPointer, '/a/c');
      assert.equal(r.errors[0]!.expected, 9);
      assert.equal(r.errors[0]!.actual, 2);
    }
  });

  it('失败：数组长度不同', () => {
    const r = applyPatch([1, 2], [{ op: 'test', path: '', value: [1, 2, 3] }]);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.errors[0]!.code, 'TEST_FAILED');
      assert.equal(r.errors[0]!.mismatchPointer, '');
    }
  });

  it('失败：数组元素不同，mismatchPointer 指向下标', () => {
    const r = applyPatch([1, 2, 3], [{ op: 'test', path: '', value: [1, 9, 3] }]);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.errors[0]!.mismatchPointer, '/1');
  });

  it('NaN 与 NaN 按 SameValue 相等；+0 与 -0 不相等', () => {
    assert.deepEqual(apply({ n: NaN }, [{ op: 'test', path: '/n', value: NaN }]), { n: NaN });
    const r = applyPatch({ n: 0 }, [{ op: 'test', path: '/n', value: -0 }]);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.errors[0]!.code, 'TEST_FAILED');
  });

  it('test 路径不存在失败', () => {
    const r = applyPatch({}, [{ op: 'test', path: '/missing', value: 1 }]);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.errors[0]!.code, 'PATH_NOT_FOUND');
  });

  it('test 使用末尾标记 "-" 失败（"-" 不指向已存在的元素）', () => {
    const r = applyPatch({ foo: [1] }, [{ op: 'test', path: '/foo/-', value: 2 }]);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.errors[0]!.code, 'INVALID_ARRAY_INDEX');
  });

  it('test 成功后后续操作继续执行', () => {
    assert.deepEqual(
      apply({ a: 1 }, [
        { op: 'test', path: '/a', value: 1 },
        { op: 'add', path: '/b', value: 2 },
      ]),
      { a: 1, b: 2 },
    );
  });
});

describe('多操作序列（RFC 附录 A 示例）', () => {
  it('A.1 综合示例', () => {
    const doc = {
      foo: ['bar', 'baz'],
      baz: 'qux',
      '': 0,
      'a/b': 1,
      'c%d': 2,
      'e^f': 3,
      'g|h': 4,
      'i\\j': 5,
      'k"l': 6,
      ' ': 7,
      'm~n': 8,
    };
    const ops: PatchOperation[] = [
      { op: 'add', path: '/foo/-', value: ['qux', 'root'] },
      // 注意：RFC 6902 附录 A.1 指出 "-" 对 test 不可解析（它不指向已存在元素），
      // 因此追加后用具体下标 /foo/2 验证。
      { op: 'test', path: '/foo/2', value: ['qux', 'root'] },
      { op: 'test', path: '/foo/2/1', value: 'root' },
    ];
    const out = apply(doc, ops);
    assert.deepEqual((out as { foo: unknown[] }).foo, ['bar', 'baz', ['qux', 'root']]);
  });

  it('转义路径可用于每个需要路径的操作', () => {
    const doc = { 'a/1': [10, 20], '~': { nested: true } } as JsonValue;
    const out = apply(doc, [
      { op: 'test', path: '/a~11/0', value: 10 },
      { op: 'replace', path: '/~0/nested', value: false },
      { op: 'move', from: '/a~11/1', path: '/~0/moved' },
      { op: 'copy', from: '/~0/moved', path: '/copied' },
    ]);
    assert.deepEqual(out, {
      'a/1': [10],
      '~': { nested: false, moved: 20 },
      copied: 20,
    });
  });
});
