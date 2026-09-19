import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  escapeToken,
  formatPointer,
  isArrayIndexToken,
  parseArrayIndex,
  parsePointer,
  unescapeToken,
  PointerSyntaxError,
} from '../src/pointer.js';

describe('JSON Pointer 波浪号转义（RFC 6901）', () => {
  it('解码顺序必须是 ~1 先于 ~0', () => {
    // 经典用例："~01" 必须先解 ~0 还是 ~1？规范要求 ~1 -> '/'，~0 -> '~'
    // 从左到右扫描即可；"~01" => "~1"，"~10" => "/0"
    assert.equal(unescapeToken('~01'), '~1');
    assert.equal(unescapeToken('~10'), '/0');
  });

  it('RFC 示例字符串', () => {
    assert.equal(unescapeToken('a~1b'), 'a/b');
    assert.equal(unescapeToken('a~0b'), 'a~b');
    assert.equal(unescapeToken('~0~1'), '~/');
    assert.equal(unescapeToken('~1~0'), '/~');
    assert.equal(unescapeToken(''), '');
  });

  it('编码顺序必须是 ~0 先于 ~1', () => {
    assert.equal(escapeToken('a/b'), 'a~1b');
    assert.equal(escapeToken('a~b'), 'a~0b');
    assert.equal(escapeToken('~/'), '~0~1');
    assert.equal(escapeToken('/~'), '~1~0');
  });

  it('编码-解码往返', () => {
    for (const s of ['/~', 'a~b/c', '~~', '//', 'x~0y', '~', '/', 'a~1b']) {
      assert.equal(unescapeToken(escapeToken(s)), s);
    }
  });

  it('非法转义（孤立的 ~）必须报错', () => {
    assert.throws(() => unescapeToken('a~b'), PointerSyntaxError);
    assert.throws(() => unescapeToken('~'), PointerSyntaxError);
    assert.throws(() => unescapeToken('~2'), PointerSyntaxError);
  });

  it('parsePointer：根与层级切分', () => {
    assert.deepEqual(parsePointer('').tokens, []);
    assert.deepEqual(parsePointer('/').tokens, ['']);
    assert.deepEqual(parsePointer('/a/b').tokens, ['a', 'b']);
    assert.deepEqual(parsePointer('/a~1b/~0~0').tokens, ['a/b', '~~']);
  });

  it('parsePointer：不以 / 开头的非空指针非法', () => {
    assert.throws(() => parsePointer('a/b'), PointerSyntaxError);
  });

  it('parsePointer：token 内非法转义被拒绝', () => {
    assert.throws(() => parsePointer('/a~2b'), PointerSyntaxError);
  });

  it('formatPointer 与 parsePointer 往返', () => {
    for (const p of ['', '/', '/a/b', '/a~1b', '/~0~1', '/ ']) {
      assert.equal(formatPointer(parsePointer(p).tokens), p);
    }
  });
});

describe('数组下标 token', () => {
  it('合法形式', () => {
    assert.equal(isArrayIndexToken('0'), true);
    assert.equal(isArrayIndexToken('1'), true);
    assert.equal(isArrayIndexToken('12'), true);
    assert.equal(isArrayIndexToken('9007199254740991'), true);
  });

  it('前导零非法（"00"、"01"）', () => {
    assert.equal(isArrayIndexToken('00'), false);
    assert.equal(isArrayIndexToken('01'), false);
    assert.equal(isArrayIndexToken('007'), false);
  });

  it('非数字、负号、加号非法', () => {
    assert.equal(isArrayIndexToken('-1'), false);
    assert.equal(isArrayIndexToken('+1'), false);
    assert.equal(isArrayIndexToken('1a'), false);
    assert.equal(isArrayIndexToken(''), false);
    assert.equal(isArrayIndexToken('-'), false);
  });

  it('parseArrayIndex："-" 是末尾追加标记', () => {
    assert.deepEqual(parseArrayIndex('-'), { index: -1, append: true });
    assert.deepEqual(parseArrayIndex('0'), { index: 0, append: false });
    assert.deepEqual(parseArrayIndex('42'), { index: 42, append: false });
  });

  it('parseArrayIndex：非法 token 抛错', () => {
    assert.throws(() => parseArrayIndex('01'));
    assert.throws(() => parseArrayIndex('x'));
  });
});
