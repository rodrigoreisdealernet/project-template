import { describe, expect, it } from "vitest";
import { isLowConfidence, LOW_CONFIDENCE_THRESHOLD } from "./index";

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
