import { describe, expect, it } from "vitest";
import {
  countPendingReview,
  isLowConfidence,
  isOutOfRangeConfidence,
  LOW_CONFIDENCE_THRESHOLD,
  needsReview,
} from "./index";

// BR-9: confidence below the threshold is flagged "low confidence" on the results screen.
describe("isLowConfidence", () => {
  it("flags values below the threshold", () => {
    expect(isLowConfidence(0.5)).toBe(true);
    expect(isLowConfidence(0)).toBe(true);
  });

  it("does not flag values at or above the threshold", () => {
    expect(isLowConfidence(LOW_CONFIDENCE_THRESHOLD)).toBe(false);
    expect(isLowConfidence(0.9)).toBe(false);
    expect(isLowConfidence(1)).toBe(false);
  });

  it("does not flag missing/non-numeric confidence", () => {
    expect(isLowConfidence(null)).toBe(false);
    expect(isLowConfidence(undefined)).toBe(false);
    expect(isLowConfidence("0.1")).toBe(false);
  });
});

// Regression (red-team #3): a probability must be in [0, 1]. An impossible value
// like 1.5 ("150%") must NOT be trusted as high-confidence.
describe("isOutOfRangeConfidence", () => {
  it("flags values above 1 or below 0", () => {
    expect(isOutOfRangeConfidence(1.5)).toBe(true);
    expect(isOutOfRangeConfidence(-0.5)).toBe(true);
  });

  it("does not flag values within [0, 1] or non-numbers", () => {
    expect(isOutOfRangeConfidence(0)).toBe(false);
    expect(isOutOfRangeConfidence(1)).toBe(false);
    expect(isOutOfRangeConfidence(0.42)).toBe(false);
    expect(isOutOfRangeConfidence(null)).toBe(false);
  });
});

describe("needsReview", () => {
  it("is true for confidence below the threshold", () => {
    expect(needsReview({ confidence: 0.5 })).toBe(true);
    expect(needsReview({ confidence: 0 })).toBe(true);
  });

  it("is true for an out-of-range (impossible) confidence — never silently 'high'", () => {
    expect(needsReview({ confidence: 1.5 })).toBe(true);
    expect(needsReview({ confidence: -0.2 })).toBe(true);
  });

  it("is false at or above the threshold (and within range)", () => {
    expect(needsReview({ confidence: LOW_CONFIDENCE_THRESHOLD })).toBe(false);
    expect(needsReview({ confidence: 0.9 })).toBe(false);
    expect(needsReview({ confidence: 1 })).toBe(false);
  });

  it("is false for null/missing confidence", () => {
    expect(needsReview({ confidence: null })).toBe(false);
    // Non-numeric confidence is treated as "no flag" (mirrors isLowConfidence).
    expect(needsReview({ confidence: "0.1" as unknown as number })).toBe(false);
  });
});

describe("countPendingReview", () => {
  it("counts only the low-confidence rows in a mixed array", () => {
    const rows = [
      { confidence: 0.2 }, // low -> counts
      { confidence: 0.95 }, // high -> no
      { confidence: null }, // missing -> no
      { confidence: 0.69 }, // low -> counts
      { confidence: LOW_CONFIDENCE_THRESHOLD }, // at threshold -> no
    ];
    expect(countPendingReview(rows)).toBe(2);
  });

  it("returns 0 for an empty array", () => {
    expect(countPendingReview([])).toBe(0);
  });
});
