# json-patch-transaction-core

内存型 [RFC 6902 JSON Patch](https://www.rfc-editor.org/rfc/rfc6902) 库（TypeScript / Node.js 20，零运行时依赖）。
对普通 JSON 值执行 `add`、`remove`、`replace`、`move`、`copy`、`test`，只提供库接口与测试，无 CLI、无页面。

## 特性 / 保证

- **原子事务**：一次 `applyPatch` 接收一组操作。任何一步失败，立即停止，返回的 `doc` 与入参 `===` 同一引用；调用者文档不会被修改，也不会留下前几步的部分结果。
- **Copy-on-write**：每一步基于上一步结果构建新根，只复制指针路径上的节点，未触及的子树与源文档共享只读引用。成功路径不经过 `JSON.stringify/parse`，数字（含 `-0`、指数形式、大整数）、布尔量原样保留，也不会调用对象上的 `toJSON`。
- **JSON Pointer (RFC 6901)**：正确处理 `~0`/`~1` 转义（转义解析与错误的 `~` 序列）、数组下标（禁止前导零、`> 2^32-1` 拒绝）、末尾追加标记 `-`（仅对数组有效；对象上的 `-` 是普通成员名）。
- **move 语义**：
  - `from` 是 `path` 的真前缀（移入自身后代）时以 `MOVE_INTO_DESCENDANT` 拒绝；
  - 同一数组内移动时，先删源、再在**删除后**的数组上按目标下标插入（RFC A.18：`/a/1 → /a/2` 作用于 `["A","B","C"]` 得到 `["A","C","B"]`）。
- **copy 引用隔离**：复制出的对象/数组与源节点不共享任何可变容器。
- **结构化错误位置**：失败结果包含失败操作下标、op 名、错误码、`path`/`from` 归属、已解析到的最深指针、失败 token；`test` 失败还给出首个差异位置。

## 用法

```ts
import { applyPatch } from "json-patch-transaction-core";

const result = applyPatch(
  { a: [1, 2] },
  [
    { op: "add", path: "/a/-", value: 3 },
    { op: "test", path: "/a/2", value: 3 },
    { op: "move", from: "/a/0", path: "/a/-" },
  ],
);

if (result.ok) {
  result.doc; // { a: [2, 3, 1] }
} else {
  result.doc;     // === 原始文档引用（未改动）
  result.errors;  // [{ index, op, code, pointerField, resolvedPath, failedToken, ... }]
}
```

### 错误码

| code | 含义 |
| --- | --- |
| `MALFORMED_OPERATION` | 操作对象结构/字段类型不对（执行前校验，整批不生效） |
| `POINTER_SYNTAX` | JSON Pointer 非法（错误的 `~` 转义、非字符串） |
| `PATH_NOT_FOUND` | 遍历遇到不存在的对象成员/数组元素 |
| `INVALID_ARRAY_INDEX` | 数组位置上的 token 不是合法下标（或对 `-` 做 remove/replace） |
| `INDEX_OUT_OF_BOUNDS` | 数值下标超出该操作允许的范围 |
| `TYPE_MISMATCH` | 试图穿过 null/字符串/数字/布尔继续向下寻址 |
| `MOVE_INTO_DESCENDANT` | `move` 的目标位于 `from` 节点内部 |
| `REMOVE_ROOT` | 对空指针执行 `remove` |
| `TEST_FAILED` | `test` 深度比较不通过（附带 `mismatchPath`） |
| `CYCLIC_VALUE` | 待写入/复制的值含引用环，不是合法 JSON 值 |

### 还导出的辅助接口

- `parsePointer(ptr, field?)` / `formatPointer(tokens)` — Pointer 解析与序列化
- `parseArrayIndex(token)` / `isAppendToken(token)`
- `cloneJson(value)` — 手写深拷贝（不走 JSON 序列化；遇环抛 `CyclicValueError`）
- `firstDifference(actual, expected)` — 返回首个差异的相对指针，相等返回 `null`

## 构建与测试

```bash
npm install
npm run build   # tsc -> dist/
npm test        # 编译库与测试，使用 node:test 运行（92 个测试）
```

测试覆盖：转义路径（`~0`/`~1`、畸形转义）、RFC 6902 附录用例、同数组移动的删除后下标语义、各类失败整批回滚（含引用指纹对比）、copy 后引用隔离、大文档 spine 编辑的性能特征与 `toJSON` 不被调用。
