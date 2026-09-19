import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parsePointer,
  formatPointer,
  parseArrayIndex,
  isAppendToken,
  PointerSyntaxError,
} from "../src/pointer.js";

describe("parsePointer — RFC 6901 reference tokens", () => {
  it("parses the empty pointer as zero tokens (whole document)", () => {
    assert.deepEqual(parsePointer(""), []);
  });

  it("splits on slashes, including empty segments", () => {
    assert.deepEqual(parsePointer("/"), [""]);
    assert.deepEqual(parsePointer("//"), ["", ""]);
    assert.deepEqual(parsePointer("/a//b"), ["a", "", "b"]);
  });

  it("unescapes ~0 to tilde and ~1 to slash", () => {
    assert.deepEqual(parsePointer("/a~0b"), ["a~b"]);
    assert.deepEqual(parsePointer("/a~1b"), ["a/b"]);
    assert.deepEqual(parsePointer("/~0~1"), ["~/"]);
    assert.deepEqual(parsePointer("/~1~0"), ["/~"]);
    assert.deepEqual(parsePointer("/x~0y~1z"), ["x~y/z"]);
  });

  it("handles multiple escapes within a single token", () => {
    // Property name from RFC 6901 §5: "a/b" -> "~1", "c%d", "e^f", "g|h",
    // "i\\j", "k\"l", " ", "m~n" -> "m~0n".
    const pointer = "/a~1b/c%d/e^f/g|h/i\\j/k\"l/ /m~0n";
    assert.deepEqual(parsePointer(pointer), [
      "a/b",
      "c%d",
      "e^f",
      "g|h",
      "i\\j",
      'k"l',
      " ",
      "m~n",
    ]);
  });

  it("rejects a pointer that does not start with /", () => {
    assert.throws(() => parsePointer("a/b"), PointerSyntaxError);
  });

  it("rejects malformed tilde escapes (~2, ~ at end, bare ~)", () => {
    assert.throws(() => parsePointer("/a~2b"), PointerSyntaxError);
    assert.throws(() => parsePointer("/a~"), PointerSyntaxError);
    assert.throws(() => parsePointer("/~x"), PointerSyntaxError);
  });

  it("reports whether the bad pointer lived in path or from", () => {
    try {
      parsePointer("/a~x", "from");
      assert.fail("expected throw");
    } catch (error) {
      assert.ok(error instanceof PointerSyntaxError);
      assert.equal(error.pointerName, "from");
      assert.equal(error.pointer, "/a~x");
    }
  });

  it("rejects non-string pointers", () => {
    assert.throws(() => parsePointer(42), PointerSyntaxError);
    assert.throws(() => parsePointer(null), PointerSyntaxError);
    assert.throws(() => parsePointer(undefined), PointerSyntaxError);
  });

  it("does not treat unicode or digits specially", () => {
    assert.deepEqual(parsePointer("/café/0/日本語"), ["café", "0", "日本語"]);
  });
});

describe("formatPointer — escaping for serialization", () => {
  it("produces empty string for root", () => {
    assert.equal(formatPointer([]), "");
  });

  it("escapes tilde before slash (order matters)", () => {
    assert.equal(formatPointer(["a~b"]), "/a~0b");
    assert.equal(formatPointer(["a/b"]), "/a~1b");
    // A token whose escaped form itself contains a tilde: order of replaces
    // must be ~ then /.
    assert.equal(formatPointer(["~/"]), "/~0~1");
  });

  it("round-trips through parse for tricky names", () => {
    const tokens = ["a/b", "m~n", "", "x~1literal", "k\"l", " "];
    const pointer = formatPointer(tokens);
    assert.deepEqual(parsePointer(pointer), tokens);
  });
});

describe("parseArrayIndex / isAppendToken", () => {
  it("accepts zero and plain non-leading-zero numerals", () => {
    assert.equal(parseArrayIndex("0"), 0);
    assert.equal(parseArrayIndex("3"), 3);
    assert.equal(parseArrayIndex("4294967295"), 0xffffffff);
  });

  it("rejects leading zeros", () => {
    assert.equal(parseArrayIndex("01"), null);
    assert.equal(parseArrayIndex("00"), null);
  });

  it("rejects non-digit tokens", () => {
    assert.equal(parseArrayIndex(""), null);
    assert.equal(parseArrayIndex("1a"), null);
    assert.equal(parseArrayIndex("-1"), null);
    assert.equal(parseArrayIndex("1.5"), null);
    assert.equal(parseArrayIndex(" 1"), null);
  });

  it("rejects values above 2^32-1", () => {
    assert.equal(parseArrayIndex("4294967296"), null);
  });

  it("recognizes the append marker separately", () => {
    assert.equal(isAppendToken("-"), true);
    assert.equal(parseArrayIndex("-"), null);
    assert.equal(isAppendToken("--"), false);
  });
});
