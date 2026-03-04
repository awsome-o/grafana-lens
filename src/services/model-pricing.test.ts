import { describe, expect, test } from "vitest";
import { estimateCostFallback } from "./model-pricing.js";

describe("estimateCostFallback", () => {
  test("returns cost for known Anthropic model", () => {
    const cost = estimateCostFallback("anthropic", "claude-opus-4-6", {
      input: 1000,
      output: 500,
      cacheRead: 200,
      cacheWrite: 100,
    });
    // (1000*15 + 500*75 + 200*1.5 + 100*18.75) / 1_000_000
    // = (15000 + 37500 + 300 + 1875) / 1_000_000
    // = 54675 / 1_000_000 = 0.054675
    expect(cost).toBeCloseTo(0.054675, 6);
  });

  test("returns undefined for unknown provider", () => {
    expect(estimateCostFallback("unknown-provider", "claude-opus-4-6", { input: 100 })).toBeUndefined();
  });

  test("returns undefined for unknown model", () => {
    expect(estimateCostFallback("anthropic", "unknown-model", { input: 100 })).toBeUndefined();
  });

  test("returns undefined when provider is undefined", () => {
    expect(estimateCostFallback(undefined, "claude-opus-4-6", { input: 100 })).toBeUndefined();
  });

  test("returns undefined when model is undefined", () => {
    expect(estimateCostFallback("anthropic", undefined, { input: 100 })).toBeUndefined();
  });

  test("returns undefined when usage is undefined", () => {
    expect(estimateCostFallback("anthropic", "claude-opus-4-6", undefined)).toBeUndefined();
  });

  test("returns undefined when all usage values are zero", () => {
    expect(estimateCostFallback("anthropic", "claude-opus-4-6", {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    })).toBeUndefined();
  });

  test("handles missing usage fields (defaults to 0)", () => {
    const cost = estimateCostFallback("anthropic", "claude-sonnet-4-6", { output: 1000 });
    // (0*3 + 1000*15 + 0*0.3 + 0*3.75) / 1_000_000 = 15000 / 1_000_000 = 0.015
    expect(cost).toBeCloseTo(0.015, 6);
  });

  test("works for haiku model", () => {
    const cost = estimateCostFallback("anthropic", "claude-haiku-4-5-20251001", {
      input: 10000,
      output: 5000,
    });
    // (10000*0.8 + 5000*4) / 1_000_000 = (8000 + 20000) / 1_000_000 = 0.028
    expect(cost).toBeCloseTo(0.028, 6);
  });

  test("works for older sonnet model", () => {
    const cost = estimateCostFallback("anthropic", "claude-sonnet-4-5-20250514", { input: 1000 });
    // (1000*3) / 1_000_000 = 0.003
    expect(cost).toBeCloseTo(0.003, 6);
  });
});
