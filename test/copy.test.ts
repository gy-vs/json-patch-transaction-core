import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyPatch } from "../src/patch.js";
import type { JsonValue } from "../src/types.js";

describe("copy — RFC A.9 .. A.12 plus reference isolation", () => {
  it("copies a primitive value (RFC A.10)", () => {
    const result = applyPatch(
      { foo: 1, baz: [{ qux: "hello" }] },
      [{ op: "copy", from: "/foo", path: "/bar" }],
    );
    assert.deepEqual(result.doc, {
      foo: 1,
      bar: 1,
      baz: [{ qux: "hello" }],
    });
  });

  it("copies an object into a new member (RFC A.12)", () => {
    const result = applyPatch(
      { foo: { x: { y: 42 } } },
      [{ op: "copy", from: "/foo/x", path: "/foo/z" }],
    );
    assert.deepEqual(result.doc, {
      foo: { x: { y: 42 }, z: { y: 42 } },
    });
  });

  it("copies into an array with insertion semantics (RFC A.11)", () => {
    const result = applyPatch(
      { foo: [1, 2, 3] },
      [{ op: "copy", from: "/foo/1", path: "/foo/0" }],
    );
    assert.deepEqual(result.doc, { foo: [2, 1, 2, 3] });
  });

  it("does not share mutable references between source and copy", () => {
    const sourceChild = { deep: { value: [1, 2, 3] } };
    const doc: JsonValue = { src: sourceChild };
    const result = applyPatch(doc, [
      { op: "copy", from: "/src", path: "/dst" },
    ]);
    assert.equal(result.ok, true);

    const out = result.doc as {
      src: { deep: { value: number[] } };
      dst: { deep: { value: number[] } };
    };
    assert.notEqual(out.dst, out.src);
    assert.notEqual(out.dst.deep, out.src.deep);
    assert.notEqual(out.dst.deep.value, out.src.deep.value);

    // Mutating the copy must not be observable through the source.
    out.dst.deep.value.push(999);
    out.dst.deep.value = [];
    assert.deepEqual(out.src.deep.value, [1, 2, 3]);
  });

  it("leaves the caller's document completely untouched", () => {
    const child = { nested: [10, 20] };
    const doc: JsonValue = { child, other: "x" };
    const snapshot = structuredClone(doc);
    const result = applyPatch(doc, [
      { op: "copy", from: "/child", path: "/clone" },
    ]);
    assert.equal(result.ok, true);
    assert.deepEqual(doc, snapshot);
    // The source node in the OUTPUT is still the exact same container
    // reference as in the input (copy-on-write shares untouched nodes).
    assert.equal((result.doc as { child: unknown }).child, child);
  });

  it("keeps copy and source independent after multiple sequential copies", () => {
    let doc: JsonValue = { shared: { count: 1, list: [0] } };
    const r1 = applyPatch(doc, [{ op: "copy", from: "/shared", path: "/c1" }]);
    assert.equal(r1.ok, true);
    doc = r1.doc;
    const r2 = applyPatch(doc, [{ op: "copy", from: "/shared", path: "/c2" }]);
    assert.equal(r2.ok, true);
    const out = r2.doc as {
      shared: { count: number; list: number[] };
      c1: { count: number; list: number[] };
      c2: { count: number; list: number[] };
    };
    assert.notEqual(out.shared, out.c1);
    assert.notEqual(out.shared, out.c2);
    assert.notEqual(out.c1, out.c2);
    out.c1.list.push(7);
    assert.deepEqual(out.shared.list, [0]);
    assert.deepEqual(out.c2.list, [0]);
  });

  it("copies the whole document when path is empty", () => {
    const doc = { a: [1, { b: 2 }] };
    const result = applyPatch(doc, [
      { op: "copy", from: "", path: "" },
    ]);
    assert.equal(result.ok, true);
    assert.deepEqual(result.doc, doc);
    assert.notEqual(result.doc, doc);
    assert.notEqual((result.doc as { a: unknown[] }).a, doc.a);
  });

  it("supports escaped tokens in from", () => {
    const doc: JsonValue = { "a~b": [1], "c/d": null };
    const result = applyPatch(doc, [
      { op: "copy", from: "/a~0b", path: "/c~1d" },
    ]);
    assert.deepEqual(result.doc, { "a~b": [1], "c/d": [1] });
    assert.notStrictEqual(
      (result.doc as Record<string, number[]>)[`a~b`],
      (result.doc as Record<string, number[]>)[`c/d`],
    );
  });

  it("fails when from does not resolve", () => {
    const result = applyPatch({ a: 1 }, [
      { op: "copy", from: "/missing", path: "/b" },
    ]);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0]?.code, "PATH_NOT_FOUND");
  });
});

describe("deep clone primitive fidelity", () => {
  it("preserves numbers (including -0), booleans and null exactly", () => {
    const doc: JsonValue = { n: 0, neg: -0, big: 1e308, t: true, f: false, z: null };
    const result = applyPatch(doc, [
      { op: "copy", from: "", path: "/copy" },
    ]);
    assert.equal(result.ok, true);
    const copy = (result.doc as { copy: typeof doc }).copy;
    assert.equal(copy.n, 0);
    assert.ok(Object.is(copy.neg, -0));
    assert.equal(copy.big, 1e308);
    assert.equal(copy.t, true);
    assert.equal(copy.f, false);
    assert.equal(copy.z, null);
  });
});
