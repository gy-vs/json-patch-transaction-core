# json-patch-inmem

内存内、原子化的 [RFC 6902 JSON Patch](https://www.rfc-editor.org/rfc/rfc6902) 库（TypeScript / Node.js 20）。
路径使用 [RFC 6901 JSON Pointer](https://www.rfc-editor.org/rfc/rfc6901)。仅库接口与测试，无 CLI / 页面；不依赖任何 JSON Patch 库。

## 特性

- 六个操作：`add` / `remove` / `replace` / `move` / `copy` / `test`
- JSON Pointer：`~0` / `~1` 波浪号转义（解码顺序严格遵循 RFC）、数组下标语法（拒绝前导零）、`-` 末尾追加标记
- **原子 apply**：操作只作用于入参文档的深拷贝；任一步失败即丢弃整份副本，入参文档不被触碰，也不留部分结果
- **move 语义**：目标位于源节点内部时以 `MOVE_INTO_SELF` 拒绝；同一数组内移动严格按 RFC 4.3 的"先移除再插入"处理下标变化
- **引用隔离**：`copy` 插入的是源值深拷贝；`add`/`replace` 的 `value` 同样深拷贝；返回文档与入参不共享任何可变节点
- 深拷贝与深度比较均为**迭代式**实现，不使用 `JSON.parse(JSON.stringify(...))`，数值语义（NaN、-0）与大文档/深文档性能可预测，且不会压垮调用栈
- 结构化错误：失败步骤下标、错误码、涉及字段（`path`/`from`/`value`/`op`）、指针、token 下标、test 的首个差异位置与差异值；静态结构校验会一次收集全部错误

## 使用

```ts
import { applyPatch } from './dist/index.js';

const result = applyPatch(
  { foo: [1, 2, 3] },
  [
    { op: 'add', path: '/foo/-', value: 4 },
    { op: 'move', from: '/foo/0', path: '/foo/2' },
    { op: 'test', path: '/foo/2', value: 1 },
    { op: 'copy', from: '/foo/3', path: '/tail' },
  ],
);

if (result.ok) {
  result.doc;    // 新文档：{ foo: [2, 3, 1, 4], tail: 4 }
  result.errors; // []
} else {
  result.doc;    // 与入参同一引用，完全未修改
  result.errors; // PatchError[]，执行期失败恰有一条
}
```

### `PatchError`

```ts
interface PatchError {
  opIndex: number;            // 失败操作下标；补丁本身非法 / 文档类型不支持时为 -1
  code: PatchErrorCode;       // 见下
  message: string;
  field?: 'op' | 'path' | 'from' | 'value';
  pointer?: string;           // 失败涉及的 JSON Pointer
  tokenIndex?: number;        // 首个无法解析的 token 下标（0 起）
  mismatchPointer?: string;   // test 失败：文档绝对指针形式的首个差异位置
  expected?: JsonValue;       // test 失败：差异节点的期望值
  actual?: JsonValue;         // test 失败：差异节点的实际值
}
```

错误码：`POINTER_SYNTAX`、`INVALID_ARRAY_INDEX`、`OUT_OF_RANGE`、`PATH_NOT_FOUND`、
`TYPE_MISMATCH`、`ROOT_NOT_REMOVABLE`、`MOVE_INTO_SELF`、`TEST_FAILED`、
`MALFORMED_PATCH`、`MALFORMED_OP`、`UNSUPPORTED_TYPE`。

## 测试

```bash
npm test        # node:test + tsx，91 个用例
npm run typecheck
npm run build
```

覆盖：转义路径（含 `~01`/`~10` 顺序、孤立 `~`、真实键 `/` 与 `~`）、数组下标与 `-`、
RFC 附录示例、同一数组内前后移动与越界、move 到源内部、copy/move/add 的引用隔离、
失败回滚（多步后失败、静态多错误收集）、成功路径禁用 `JSON.stringify`/`parse` 的间谍测试、
5 万节点性能上限与 2 万层深度不爆栈。

## 目录

```
src/
  types.ts     公共类型：JsonValue、操作、PatchError、ApplyResult
  pointer.ts   RFC 6901 解析 / 转义 / 下标 / 沿指针取值
  clone.ts     迭代式结构化深拷贝
  equality.ts  迭代式 SameValue 深比较，返回首个差异位置
  patch.ts     静态校验 + 原子 applyPatch
  index.ts     公共导出
tests/         pointer / operations / atomicity / isolation 四组测试
```
