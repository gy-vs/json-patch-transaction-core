import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { applyPatch } from "../src/patch.js";
import type { JsonArray, JsonValue } from "../src/types.js";

/**
 * These tests guard the performance model required by the task:
 *
 *  - the hot path never serializes the document to a JSON string;
 *  - a small targeted edit on a huge document is proportional to the
 *    pointer spine, not to the document size (copy-on-write);
 *  - numbers and booleans survive untouched (no normalization pass).
 */

function buildLargeDocument(n: number): JsonValue {
  // ~ n objects, each with a small nested payload.
  const items: JsonArray = [];
  for (let i = 0; i < n; i++) {
    items.push({
      id: i,
      name: `item-${i}`,
      meta: { checked: i % 2 === 0, score: i * 1.5, tags: [i, i + 1] },
    });
  }
  return { items, count: n, marker: { deep: { untouched: true } } };
}

describe("performance characteristics", () => {
  it("edits one element of a 100k-element array without cloning the rest", () => {
    const n = 100_000;
    const doc = buildLargeDocument(n);
    const originalItems = (doc as { items: JsonArray }).items;

    const start = performance.now();
    const result = applyPatch(doc, [
      { op: "replace", path: `/items/${n - 1}/meta/score`, value: -1 },
    ]);
    const elapsed = performance.now() - start;

    assert.equal(result.ok, true);
    // Only the array spine + one item subtree were copied; every untouched
    // element object is still shared with the caller's document.
    const outItems = (result.doc as { items: JsonArray }).items;
    assert.notEqual(outItems, originalItems);
    for (const i of [0, 1, Math.floor(n / 2), n - 2]) {
      assert.equal(outItems[i], originalItems[i], `index ${i} must be shared`);
    }
    assert.notEqual(outItems[n - 1], originalItems[n - 1]);

    // A spine edit must be fast. Bound deliberately generous; JSON
    // round-tripping 100k objects takes tens to hundreds of milliseconds.
    assert.ok(
      elapsed < 500,
      `spine edit took ${elapsed.toFixed(1)}ms; expected copy-on-write speed`,
    );
  });

  it("keeps cost proportional to the edit depth, not document width", () => {
    // Two documents: 1k items vs 100k items, same edit depth.
    const small = buildLargeDocument(1_000);
    const large = buildLargeDocument(100_000);

    const editLastScore = (d: JsonValue, size: number) =>
      applyPatch(d, [
        { op: "replace", path: `/items/${size - 1}/meta/score`, value: 0 },
      ]);

    // Warm up both (JIT).
    editLastScore(small, 1_000);
    editLastScore(large, 100_000);

    const runs = 20;
    const timeIt = (d: JsonValue, size: number): number => {
      const start = performance.now();
      for (let i = 0; i < runs; i++) editLastScore(d, size);
      return performance.now() - start;
    };

    const smallMs = timeIt(small, 1_000);
    const largeMs = timeIt(large, 100_000);
    // The 100x larger document must not be 100x slower; even a generous
    // factor confirms no full-document traversal.
    assert.ok(
      largeMs < smallMs * 20 + 200,
      `100x larger doc took ${largeMs.toFixed(1)}ms vs ${smallMs.toFixed(1)}ms`,
    );
  });

  it("preserves large integers and numeric forms verbatim", () => {
    const doc: JsonValue = {
      int64ish: 9007199254740993 - 1, // 2^53+1-1 — values are what the caller gave
      precise: 9007199254740992,
      decimal: 0.1 + 0.2 - 0.2,
      exp: 1.234e-100,
      flag: false,
    };
    const result = applyPatch(doc, [
      { op: "add", path: "/other", value: true },
    ]);
    assert.equal(result.ok, true);
    const out = result.doc as Record<string, number | boolean>;
    assert.equal(out.precise, 9007199254740992);
    assert.equal(out.decimal, 0.1 + 0.2 - 0.2);
    assert.equal(out.exp, 1.234e-100);
    assert.equal(out.flag, false);
  });

  it("never invokes toJSON on patched objects", () => {
    // If an implementation used JSON.parse(JSON.stringify(doc)), this
    // poisoned object would collapse into a string.
    const poisoned = {
      toJSON(): string {
        throw new Error("toJSON must not be called");
      },
      keep: 1,
    };
    const doc: JsonValue = { poisoned: poisoned as unknown as JsonValue };
    const result = applyPatch(doc, [
      { op: "add", path: "/x", value: 1 },
      { op: "copy", from: "/poisoned", path: "/clone" },
      { op: "test", path: "/poisoned/keep", value: 1 },
    ]);
    assert.equal(result.ok, true);
    const out = result.doc as unknown as {
      poisoned: typeof poisoned;
      clone: { keep: number };
    };
    assert.equal(out.poisoned.keep, 1);
    assert.equal(out.clone.keep, 1);
  });
});
