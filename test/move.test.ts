import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyPatch } from "../src/patch.js";
import type { JsonValue } from "../src/types.js";

describe("move — RFC A.13 .. A.18 and descendant rule", () => {
  it("moves an object value to a new member (RFC A.14)", () => {
    const result = applyPatch(
      { foo: { bar: "baz", waldo: "fred" }, qux: { corge: "grault" } },
      [{ op: "move", from: "/foo/waldo", path: "/foo/qux" }],
    );
    assert.deepEqual(result.doc, {
      foo: { bar: "baz", qux: "fred" },
      qux: { corge: "grault" },
    });
  });

  it("moves within the same array using post-removal indices (RFC A.18)", () => {
    // The canonical spec example: moving /a/1 to /a/2 on
    // { a: ["A", "B", "C"] } removes "B" first (["A","C"]), then inserts at
    // index 2, i.e. past the end => ["A", "C", "B"].
    const result = applyPatch(
      { a: ["A", "B", "C"] },
      [{ op: "move", from: "/a/1", path: "/a/2" }],
    );
    assert.deepEqual(result.doc, { a: ["A", "C", "B"] });
  });

  it("moves an array element to a lower index in the same array", () => {
    // Spec semantics: remove index 2 from [0,1,2,3] -> [0,1,3], then insert
    // at index 1 -> [0,2,1,3]. The target index is evaluated on the array
    // after the source was removed.
    const result = applyPatch(
      [0, 1, 2, 3],
      [{ op: "move", from: "/2", path: "/1" }],
    );
    assert.deepEqual(result.doc, [0, 2, 1, 3]);
  });

  it("moves to the append marker after removal", () => {
    const result = applyPatch(
      [1, 2, 3],
      [{ op: "move", from: "/0", path: "/-" }],
    );
    assert.deepEqual(result.doc, [2, 3, 1]);
  });

  it("moves between two different arrays", () => {
    const doc = { src: [1, 2, 3], dst: [9] };
    const result = applyPatch(doc, [
      { op: "move", from: "/src/1", path: "/dst/0" },
    ]);
    assert.deepEqual(result.doc, { src: [1, 3], dst: [2, 9] });
  });

  it("moves the root to an empty path as a no-op", () => {
    const doc = { a: 1 };
    const result = applyPatch(doc, [{ op: "move", from: "", path: "" }]);
    assert.equal(result.ok, true);
    assert.equal(result.doc, doc);
  });

  it("treats same-location move as a successful no-op (RFC A.13)", () => {
    const doc = { foo: { bar: [1, 2, 3] } };
    const result = applyPatch(doc, [
      { op: "move", from: "/foo/bar", path: "/foo/bar" },
    ]);
    assert.equal(result.ok, true);
    assert.deepEqual(result.doc, doc);
  });

  it("rejects moving a node into its own descendant", () => {
    const doc = { foo: { bar: { baz: 1 } } };
    const result = applyPatch(doc, [
      { op: "move", from: "/foo", path: "/foo/bar/x" },
    ]);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0]?.code, "MOVE_INTO_DESCENDANT");
    assert.equal(result.errors[0]?.pointerField, "path");
  });

  it("rejects moving root into any location", () => {
    const result = applyPatch({ a: {} }, [
      { op: "move", from: "", path: "/a/x" },
    ]);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0]?.code, "MOVE_INTO_DESCENDANT");
  });

  it("does not confuse lexical prefixes with ancestor relations (escaped slash)", () => {
    // Member "a/b" is a sibling of "a", not a descendant of /a.
    const doc: JsonValue = { "a/b": 1, a: {} };
    const result = applyPatch(doc, [
      { op: "move", from: "/a~1b", path: "/a/target" },
    ]);
    assert.equal(result.ok, true);
    assert.deepEqual(result.doc, { a: { target: 1 } });
  });

  it("rejects moving from a missing location", () => {
    const result = applyPatch({ a: 1 }, [
      { op: "move", from: "/missing", path: "/b" },
    ]);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0]?.code, "PATH_NOT_FOUND");
    assert.equal(result.errors[0]?.pointerField, "from");
  });

  it("applies post-removal indexing even when indices look shifted", () => {
    // /0 -> /2 on [A,B,C]: remove A => [B,C], insert at 2 (at end) => [B,C,A].
    const result = applyPatch(
      ["A", "B", "C"],
      [{ op: "move", from: "/0", path: "/2" }],
    );
    assert.deepEqual(result.doc, ["B", "C", "A"]);
  });

  it("fails when the post-removal target index is out of bounds", () => {
    // Remove /0 from [A,B] => [B]; insert at /5 must fail.
    const result = applyPatch(
      ["A", "B"],
      [{ op: "move", from: "/0", path: "/5" }],
    );
    assert.equal(result.ok, false);
    assert.equal(result.errors[0]?.code, "INDEX_OUT_OF_BOUNDS");
  });

  it("can move an element into a nested array of a sibling object", () => {
    const doc = { list: [1, 2], holder: { nested: [9] } };
    const result = applyPatch(doc, [
      { op: "move", from: "/list/1", path: "/holder/nested/-" },
    ]);
    assert.deepEqual(result.doc, {
      list: [1],
      holder: { nested: [9, 2] },
    });
  });
});
