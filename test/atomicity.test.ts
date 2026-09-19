import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyPatch,
  cloneJson,
  firstDifference,
  CyclicValueError,
} from "../src/index.js";
import type { JsonValue, PatchOperation } from "../src/types.js";

describe("test operation", () => {
  it("passes for equal values (RFC A.19/A.20 style)", () => {
    const doc = { a: { b: [1, 2, { c: 3 }] }, n: 42 };
    const result = applyPatch(doc, [
      { op: "test", path: "/a/b/2", value: { c: 3 } },
      { op: "test", path: "/n", value: 42 },
      { op: "test", path: "", value: doc },
    ]);
    assert.equal(result.ok, true);
  });

  it("fails on primitive mismatch and points at the location", () => {
    const result = applyPatch({ a: { b: 5 } }, [
      { op: "test", path: "/a/b", value: "5" },
    ]);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0]?.code, "TEST_FAILED");
    assert.equal(result.errors[0]?.mismatchPath, "/a/b");
  });

  it("reports the first differing nested location inside objects/arrays", () => {
    const result = applyPatch(
      { a: [1, 2, 3] },
      [{ op: "test", path: "", value: { a: [1, 9, 3] } }],
    );
    assert.equal(result.ok, false);
    assert.equal(result.errors[0]?.mismatchPath, "/a/1");
  });

  it("distinguishes object from array, extra keys and length", () => {
    const cases: Array<[JsonValue, JsonValue, string]> = [
      [{ a: [] }, { a: {} }, "/a"],
      [{ a: { x: 1 } }, { a: { x: 1, y: 2 } }, "/a"],
      [{ a: [1, 2] }, { a: [1] }, "/a"],
      [{ a: { x: 1 } }, { a: {} }, "/a"],
      [null, {}, ""],
      [true, false, ""],
    ];
    for (const [doc, expected, mismatch] of cases) {
      const result = applyPatch(doc, [
        { op: "test", path: "", value: expected },
      ]);
      assert.equal(result.ok, false);
      assert.equal(result.errors[0]?.mismatchPath, mismatch);
    }
  });

  it("compares object members independently of key order", () => {
    const result = applyPatch(
      { a: 1, b: 2 },
      [{ op: "test", path: "", value: { b: 2, a: 1 } }],
    );
    assert.equal(result.ok, true);
  });

  it("does not allow the caller to mutate the expected value afterwards", () => {
    const expected = { nested: { v: 1 } };
    const doc = { nested: { v: 1 } };
    const patch: PatchOperation[] = [
      { op: "test", path: "", value: expected },
    ];
    assert.equal(applyPatch(doc, patch).ok, true);
    // Even though the caller mutates their object, a re-application uses
    // whatever they now pass — but a single apply result is stable.
    expected.nested.v = 2;
    const second = applyPatch(doc, patch);
    assert.equal(second.ok, false);
  });
});

describe("atomicity — failure rolls the whole patch back", () => {
  it("returns the exact input reference on failure", () => {
    const doc = { a: 1, b: [10, 20] };
    const result = applyPatch(doc, [
      { op: "add", path: "/c", value: 2 },
      { op: "replace", path: "/b/5", value: 30 }, // index out of bounds
    ]);
    assert.equal(result.ok, false);
    assert.equal(result.doc, doc, "failed result must be === input doc");
  });

  it("keeps the caller document byte-for-byte unchanged after failure", () => {
    const doc = { a: 1, list: [{ x: 1 }], keep: { nested: true } };
    const snapshot = structuredClone(doc);
    const refsBefore = collectReferences(doc);

    const result = applyPatch(doc, [
      { op: "add", path: "/list/-", value: { y: 2 } },
      { op: "replace", path: "/list/0/z/w", value: 1 }, // /z missing
      { op: "remove", path: "/a" },
    ]);
    assert.equal(result.ok, false);
    assert.deepEqual(doc, snapshot);
    // No node in the input may have been replaced or mutated.
    const refsAfter = collectReferences(doc);
    assert.deepEqual([...refsAfter].sort(), [...refsBefore].sort());
  });

  it("does not leave effects from an earlier step after a later test fails", () => {
    const doc = { items: [1, 2], flag: false };
    const result = applyPatch(doc, [
      { op: "add", path: "/items/-", value: 3 },
      { op: "replace", path: "/flag", value: true },
      { op: "test", path: "/items/2", value: 99 },
    ]);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0]?.code, "TEST_FAILED");
    assert.equal(result.doc, doc);
    assert.deepEqual(doc, { items: [1, 2], flag: false });
  });

  it("rolls back a successful move when a subsequent operation fails", () => {
    const doc: JsonValue = { a: [1, 2, 3], b: {} };
    const result = applyPatch(doc, [
      { op: "move", from: "/a/0", path: "/b/x" },
      { op: "remove", path: "/missing" },
    ]);
    assert.equal(result.ok, false);
    assert.equal(result.doc, doc);
    assert.deepEqual(doc, { a: [1, 2, 3], b: {} });
  });

  it("rolls back even when several operations would have mutated deeply", () => {
    const doc = { users: [{ name: "ada", tags: ["a"] }], count: 1 };
    const snapshot = structuredClone(doc);
    const result = applyPatch(doc, [
      { op: "replace", path: "/users/0/tags/0", value: "b" },
      { op: "add", path: "/users/-", value: { name: "grace" } },
      { op: "replace", path: "/count", value: 2 },
      { op: "add", path: "/users/9/profile", value: {} }, // bad index
    ]);
    assert.equal(result.ok, false);
    assert.deepEqual(doc, snapshot);
  });

  it("stops at the FIRST failing operation and reports its index", () => {
    const result = applyPatch({ a: 1 }, [
      { op: "remove", path: "/ghost1" },
      { op: "remove", path: "/ghost2" },
    ]);
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 1);
    assert.equal(result.errors[0]?.index, 0);
    assert.equal(result.errors[0]?.op, "remove");
  });

  it("does not apply anything when a later operation is structurally invalid", () => {
    // Phase-1 validation failure: even earlier ops must not run.
    const doc = { a: 1 };
    const result = applyPatch(doc, [
      { op: "add", path: "/a", value: 2 },
      { op: "bogus", path: "/x" } as unknown as PatchOperation,
    ]);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0]?.code, "MALFORMED_OPERATION");
    assert.equal(result.errors[0]?.index, 1);
    assert.equal(result.doc, doc);
    assert.equal(doc.a, 1);
  });

  it("survives an empty patch as a no-op", () => {
    const doc = { a: 1 };
    const result = applyPatch(doc, []);
    assert.equal(result.ok, true);
    assert.equal(result.doc, doc);
  });
});

describe("input-value isolation", () => {
  it("does not let later caller mutation of an added value leak into result", () => {
    const value = { nested: [1, 2] };
    const doc = {};
    const result = applyPatch(doc, [
      { op: "add", path: "/x", value },
    ]);
    assert.equal(result.ok, true);
    value.nested.push(3);
    assert.deepEqual((result.doc as { x: { nested: number[] } }).x, {
      nested: [1, 2],
    });
  });

  it("rejects cyclic input values with a structured error", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic["self"] = cyclic;
    const result = applyPatch({} as JsonValue, [
      { op: "add", path: "/x", value: cyclic as JsonValue },
    ]);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0]?.code, "CYCLIC_VALUE");
  });
});

describe("cloneJson / firstDifference direct API", () => {
  it("cloneJson is deep and preserves -0 / large numbers", () => {
    const value: JsonValue = { a: [1, -0, 1.7976931348623157e308, true, null] };
    const copy = cloneJson(value);
    assert.notEqual(copy, value);
    assert.deepEqual(copy, value);
    (copy as { a: number[] }).a[0] = 9;
    assert.equal((value as { a: number[] }).a[0], 1);
  });

  it("cloneJson throws CyclicValueError on cycles", () => {
    const cyclic: JsonValue[] = [];
    cyclic.push(cyclic as JsonValue);
    assert.throws(() => cloneJson(cyclic), CyclicValueError);
  });

  it("firstDifference returns null on equality", () => {
    assert.equal(firstDifference({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] }), null);
  });

  it("firstDifference returns a relative pointer on mismatch", () => {
    assert.equal(firstDifference({ a: [1, 2] }, { a: [1, 3] }), "/a/1");
  });
});

function collectReferences(value: unknown): Set<string> {
  const seen = new Set<string>();
  const visit = (node: unknown, path: string): void => {
    if (node === null || typeof node !== "object") return;
    seen.add(path);
    if (Array.isArray(node)) {
      node.forEach((item, i) => visit(item, `${path}/${i}`));
    } else {
      for (const key of Object.keys(node)) {
        visit(
          (node as Record<string, unknown>)[key],
          `${path}/${key.replace(/~/g, "~0").replace(/\//g, "~1")}`,
        );
      }
    }
  };
  visit(value, "");
  return seen;
}
