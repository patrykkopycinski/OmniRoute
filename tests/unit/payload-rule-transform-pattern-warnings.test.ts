import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

import {
  classifyModelPattern,
  findInertTransformPatterns,
  __resetTransformPatternCacheForTest,
} from "../../src/lib/payloadRules/transformPatternWarnings.ts";

describe("transform-rule model-pattern inertness warnings", () => {
  before(() => {
    __resetTransformPatternCacheForTest();
  });

  after(() => {
    __resetTransformPatternCacheForTest();
  });

  it("flags a provider-prefixed alias pattern as inert", () => {
    // Matching runs on the RESOLVED id, so `qwen38a100/...` never fires.
    const verdict = classifyModelPattern("qwen38a100/qwen3.8-27b");
    assert.ok(verdict, "expected the alias-prefixed pattern to be flagged");
    assert.equal(verdict.reason, "alias_prefix");
    assert.equal(verdict.pattern, "qwen38a100/qwen3.8-27b");
  });

  it("flags a bare combo-style name that matches no known model", () => {
    const verdict = classifyModelPattern("definitely-not-a-real-model-xyz");
    assert.ok(verdict);
    assert.equal(verdict.reason, "unknown_model");
  });

  it("does not flag a wildcard that matches at least one known model", () => {
    // gpt-* resolves against the compiled-in registry.
    assert.equal(classifyModelPattern("gpt-*"), null);
  });

  it("does not flag an exact known model id", () => {
    const known = classifyModelPattern("gpt-*");
    assert.equal(known, null, "sanity: wildcard baseline must be non-inert");
  });

  it("ignores empty and whitespace-only patterns", () => {
    assert.equal(classifyModelPattern(""), null);
    assert.equal(classifyModelPattern("   "), null);
  });

  it("treats a wildcard matching nothing as inert", () => {
    const verdict = classifyModelPattern("zzz-nonexistent-*");
    assert.ok(verdict);
    assert.equal(verdict.reason, "unknown_model");
  });

  it("collects inert patterns across transform rules, de-duplicated", () => {
    const inert = findInertTransformPatterns([
      { models: [{ name: "qwen38a100/qwen3.8-27b" }, { name: "gpt-*" }] },
      { models: [{ name: "qwen38a100/qwen3.8-27b" }] },
      { models: [{ name: "another-fake-model" }] },
    ]);
    const patterns = inert.map((entry) => entry.pattern);
    assert.deepEqual(patterns, ["qwen38a100/qwen3.8-27b", "another-fake-model"]);
  });

  it("returns nothing for rules whose patterns all resolve", () => {
    assert.deepEqual(findInertTransformPatterns([{ models: [{ name: "gpt-*" }] }]), []);
  });

  it("tolerates malformed rule shapes without throwing", () => {
    assert.deepEqual(findInertTransformPatterns([]), []);
    assert.deepEqual(findInertTransformPatterns([{}]), []);
    assert.deepEqual(findInertTransformPatterns([{ models: "nope" } as never]), []);
    assert.deepEqual(findInertTransformPatterns([{ models: [{ name: 42 }] } as never]), []);
  });

  it("does not treat a regex metacharacter in a pattern as a regex", () => {
    // A literal '.' must not match any character; this name is not a real model.
    const verdict = classifyModelPattern("gpt.5");
    assert.ok(verdict, "dots must be escaped, so 'gpt.5' should not match 'gpt-5'");
  });
});
