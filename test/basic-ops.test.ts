import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyPatch } from "../src/patch.js";
import type { JsonValue, PatchOperation } from "../src/types.js";

describe("add", () => {
  it("adds a new object member", () => {
    const doc = { foo: 1 };
    const result = applyPatch(doc, [{ op: "add", path: "/bar", value: [1, 2] }]);
    assert.equal(result.ok, true);
    assert.deepEqual(result.doc, { foo: 1, bar: [1, 2] });
  });

  it("replaces an existing object member", () => {
    const doc = { foo: null };
    const result = applyPatch(doc, [{ op: "add", path: "/foo", value: 1 }]);
    assert.deepEqual(result.doc, { foo: 1 });
  });

  it("inserts into an array, shifting later elements (RFC A.3)", () => {
    const result = applyPatch(
      { foo: ["bar", "qux"] },
      [{ op: "add", path: "/foo/1", value: "baz" }],
    );
    assert.deepEqual(result.doc, { foo: ["bar", "baz", "qux"] });
  });

  it("prepends at /0 and appends at /-", () => {
    const prepend = applyPatch([1, 2], [{ op: "add", path: "/0", value: 0 }]);
    assert.deepEqual(prepend.doc, [0, 1, 2]);

    const append = applyPatch([1, 2], [{ op: "add", path: "/-", value: 3 }]);
    assert.deepEqual(append.doc, [1, 2, 3]);
  });

  it("rejects index strictly greater than length on add", () => {
    const result = applyPatch([1, 2], [{ op: "add", path: "/5", value: 3 }]);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0]?.code, "INDEX_OUT_OF_BOUNDS");
    // index === length is legal insertion:
    assert.equal(
      applyPatch([1, 2], [{ op: "add", path: "/2", value: 3 }]).ok,
      true,
    );
  });

  it("rejects leading-zero and non-numeric array indices", () => {
    for (const bad of ["/arr/01", "/arr/x"]) {
      const result = applyPatch(
        { arr: [1] },
        [{ op: "add", path: bad, value: 9 }],
      );
      assert.equal(result.ok, false, bad);
      assert.equal(result.errors[0]?.code, "INVALID_ARRAY_INDEX");
    }
  });

  it('treats "-" as a plain member name on objects', () => {
    const result = applyPatch({} as JsonValue, [
      { op: "add", path: "/-", value: "ok" },
    ]);
    assert.equal(result.ok, true);
    assert.deepEqual(result.doc, { "-": "ok" });
  });

  it("cannot descend through the append marker", () => {
    const result = applyPatch({ arr: [1] }, [
      { op: "add", path: "/arr/-/x", value: 2 },
    ]);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0]?.code, "INVALID_ARRAY_INDEX");
  });

  it("cannot traverse through a primitive", () => {
    const result = applyPatch({ n: 5 }, [
      { op: "add", path: "/n/x", value: 1 },
    ]);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0]?.code, "TYPE_MISMATCH");
  });

  it("cannot add below a missing intermediate object member", () => {
    const result = applyPatch({} as JsonValue, [
      { op: "add", path: "/missing/x", value: 1 },
    ]);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0]?.code, "PATH_NOT_FOUND");
    assert.equal(result.errors[0]?.resolvedPath, "");
    assert.equal(result.errors[0]?.failedToken, "missing");
  });

  it("uses escaped tokens to reach members with ~ and / in their names", () => {
    const doc: JsonValue = { "a/b": 1, "m~n": 2 };
    const result = applyPatch(doc, [
      { op: "add", path: "/a~1b", value: 10 },
      { op: "add", path: "/m~0n", value: 20 },
    ]);
    assert.equal(result.ok, true);
    assert.deepEqual(result.doc, { "a/b": 10, "m~n": 20 });
  });

  it("replaces the whole document when path is empty", () => {
    const result = applyPatch({ a: 1 }, [
      { op: "add", path: "", value: { b: 2 } },
    ]);
    assert.deepEqual(result.doc, { b: 2 });
  });

  it("works when the root document is an array or primitive", () => {
    assert.deepEqual(
      applyPatch([1], [{ op: "add", path: "/-", value: 2 }]).doc,
      [1, 2],
    );
    assert.deepEqual(
      applyPatch(5, [{ op: "add", path: "", value: 6 }]).doc,
      6,
    );
  });

  it("supports nested insertion deep in the document", () => {
    const doc = { a: [{ b: { c: 1 } }] };
    const result = applyPatch(doc, [
      { op: "add", path: "/a/0/b/d", value: [true, null] },
    ]);
    assert.deepEqual(result.doc, {
      a: [{ b: { c: 1, d: [true, null] } }],
    });
  });
});

describe("remove", () => {
  it("removes an object member (RFC A.2)", () => {
    const result = applyPatch(
      { baz: "qux", foo: "bar" },
      [{ op: "remove", path: "/baz" }],
    );
    assert.deepEqual(result.doc, { foo: "bar" });
  });

  it("removes an array element and closes the gap (RFC A.5)", () => {
    const result = applyPatch(
      { foo: ["bar", "qux", "baz"] },
      [{ op: "remove", path: "/foo/1" }],
    );
    assert.deepEqual(result.doc, { foo: ["bar", "baz"] });
  });

  it("fails on a missing member", () => {
    const result = applyPatch({} as JsonValue, [
      { op: "remove", path: "/nope" },
    ]);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0]?.code, "PATH_NOT_FOUND");
  });

  it("fails on out-of-bounds array index and on the append marker", () => {
    assert.equal(
      applyPatch({ a: [1] }, [{ op: "remove", path: "/a/2" }]).errors[0]
        ?.code,
      "INDEX_OUT_OF_BOUNDS",
    );
    assert.equal(
      applyPatch({ a: [1] }, [{ op: "remove", path: "/a/-" }]).errors[0]
        ?.code,
      "INVALID_ARRAY_INDEX",
    );
  });

  it("refuses to remove the root", () => {
    const result = applyPatch({ a: 1 }, [{ op: "remove", path: "" }]);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0]?.code, "REMOVE_ROOT");
  });
});

describe("replace", () => {
  it("replaces an object member (RFC A.4)", () => {
    const result = applyPatch(
      { baz: "qux", foo: "bar" },
      [{ op: "replace", path: "/baz", value: "boo" }],
    );
    assert.deepEqual(result.doc, { baz: "boo", foo: "bar" });
  });

  it("replaces an array element in place", () => {
    const result = applyPatch(
      { foo: [1, 2, 3] },
      [{ op: "replace", path: "/foo/2", value: "three" }],
    );
    assert.deepEqual(result.doc, { foo: [1, 2, "three"] });
  });

  it("requires the target to exist", () => {
    const result = applyPatch({} as JsonValue, [
      { op: "replace", path: "/missing", value: 1 },
    ]);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0]?.code, "PATH_NOT_FOUND");
  });

  it("replaces the whole document on empty path", () => {
    const result = applyPatch({ old: true }, [
      { op: "replace", path: "", value: [1, 2] },
    ]);
    assert.deepEqual(result.doc, [1, 2]);
  });
});

describe("structured error locations", () => {
  it("reports index, op, pointerField, resolvedPath and failedToken", () => {
    const patch: PatchOperation[] = [
      { op: "add", path: "/a", value: 1 },
      { op: "remove", path: "/a/x/0" },
    ];
    const result = applyPatch({ a: 5 }, patch);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0]?.index, 1);
    assert.equal(result.errors[0]?.op, "remove");
    assert.equal(result.errors[0]?.pointerField, "path");
    assert.equal(result.errors[0]?.resolvedPath, "/a");
    assert.equal(result.errors[0]?.failedToken, "x");
  });

  it("attributes traversal failures on from-pointer to pointerField=from", () => {
    const result = applyPatch(
      { x: 1 },
      [{ op: "move", from: "/missing", path: "/y" }],
    );
    assert.equal(result.ok, false);
    assert.equal(result.errors[0]?.pointerField, "from");
    assert.equal(result.errors[0]?.failedToken, "missing");
  });

  it("flags malformed operations before touching the document", () => {
    const cases: Array<{ op: unknown; fragment: string }> = [
      { op: null, fragment: "non-null object" },
      { op: { op: "frobnicate", path: "/a" }, fragment: "one of" },
      { op: { op: "add", path: 4 }, fragment: "path" },
      { op: { op: "add", path: "/a" }, fragment: "value" },
      { op: { op: "move", path: "/a" }, fragment: "from" },
    ];
    for (const { op, fragment } of cases) {
      const result = applyPatch(
        { keep: true },
        [op] as unknown as PatchOperation[],
      );
      assert.equal(result.ok, false, fragment);
      assert.equal(result.errors[0]?.code, "MALFORMED_OPERATION");
      assert.match(result.errors[0]?.message ?? "", new RegExp(fragment));
      assert.equal(result.errors[0]?.pointerField, null);
    }
  });

  it("reports POINTER_SYNTAX for a bad escape in path and from", () => {
    const badPath = applyPatch({} as JsonValue, [
      { op: "remove", path: "/a~2b" },
    ]);
    assert.equal(badPath.errors[0]?.code, "POINTER_SYNTAX");
    assert.equal(badPath.errors[0]?.pointerField, "path");

    const badFrom = applyPatch({} as JsonValue, [
      { op: "copy", from: "/~9", path: "/x" },
    ]);
    assert.equal(badFrom.errors[0]?.code, "POINTER_SYNTAX");
    assert.equal(badFrom.errors[0]?.pointerField, "from");
  });
});
