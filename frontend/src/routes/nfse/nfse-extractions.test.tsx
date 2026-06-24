import { describe, expect, it } from "vitest";
import {
  countPendingReview,
  formatDateBR,
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

// Issue #28: the "Emissão" column formats date-only ISO strings (YYYY-MM-DD) to
// Brazilian locale (DD/MM/AAAA), mirroring formatBRL's defensive fallback to "—".
describe("formatDateBR", () => {
  // AC1: valid ISO date renders DD/MM/AAAA.
  it("formats a valid YYYY-MM-DD date to DD/MM/AAAA", () => {
    expect(formatDateBR("2026-06-20")).toBe("20/06/2026");
    // Trailing/leading whitespace is trimmed before parsing.
    expect(formatDateBR("  2026-06-20  ")).toBe("20/06/2026");
    // Boundary day/month values stay intact (no off-by-one timezone shift).
    expect(formatDateBR("2026-01-01")).toBe("01/01/2026");
    expect(formatDateBR("2026-12-31")).toBe("31/12/2026");
  });

  // AC2: null / undefined render as "—" without error.
  it("returns an em dash for null or undefined", () => {
    expect(formatDateBR(null)).toBe("—");
    expect(formatDateBR(undefined)).toBe("—");
  });

  // AC2/AC3: empty or whitespace-only strings have no date to parse -> "—".
  it("returns an em dash for empty or whitespace-only strings", () => {
    expect(formatDateBR("")).toBe("—");
    expect(formatDateBR("   ")).toBe("—");
  });

  // AC3: non-string inputs are never a valid date -> "—" (no "Invalid Date").
  it("returns an em dash for non-string input", () => {
    expect(formatDateBR(20260620)).toBe("—");
    expect(formatDateBR(new Date("2026-06-20"))).toBe("—");
    expect(formatDateBR({ data_emissao: "2026-06-20" })).toBe("—");
    expect(formatDateBR(["2026-06-20"])).toBe("—");
  });

  // AC3: malformed strings (wrong separator, free text, partial dates) -> "—".
  it("returns an em dash for malformed date strings", () => {
    expect(formatDateBR("not-a-date")).toBe("—");
    expect(formatDateBR("2026/06/20")).toBe("—"); // wrong separator
    expect(formatDateBR("2026-6-20")).toBe("—"); // not zero-padded
    expect(formatDateBR("20-06-2026")).toBe("—"); // DD-MM-YYYY order
    expect(formatDateBR("2026-06-20T10:00:00Z")).toBe("—"); // datetime, not date-only
    expect(formatDateBR("2026-06")).toBe("—"); // missing day
  });

  // AC3: structurally valid but out-of-range month/day -> "—", not "Invalid Date".
  it("returns an em dash for out-of-range month or day", () => {
    expect(formatDateBR("2026-13-01")).toBe("—"); // month > 12
    expect(formatDateBR("2026-00-10")).toBe("—"); // month < 1
    expect(formatDateBR("2026-06-32")).toBe("—"); // day > 31
    expect(formatDateBR("2026-06-00")).toBe("—"); // day < 1
  });
});
