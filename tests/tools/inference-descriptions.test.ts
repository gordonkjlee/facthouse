import { describe, it, expect } from "vitest";
import {
  CAPTURE_INFERENCE_DESCRIPTION,
  LIST_INFERENCES_DESCRIPTION,
  VALIDATE_INFERENCE_DESCRIPTION,
} from "../../src/tools/inference-descriptions.js";

const TIMING =
  /\b(before|after|when|whenever|while|during|proactively|at the (start|end)|rather than|instead of|prefer)\b/i;

describe("inference tool descriptions", () => {
  it("each description is long enough to carry an occasion", () => {
    expect(CAPTURE_INFERENCE_DESCRIPTION.length).toBeGreaterThanOrEqual(120);
    expect(VALIDATE_INFERENCE_DESCRIPTION.length).toBeGreaterThanOrEqual(120);
    expect(LIST_INFERENCES_DESCRIPTION.length).toBeGreaterThanOrEqual(120);
  });

  it("each says when to call the tool", () => {
    expect(CAPTURE_INFERENCE_DESCRIPTION).toMatch(TIMING);
    expect(VALIDATE_INFERENCE_DESCRIPTION).toMatch(TIMING);
    expect(LIST_INFERENCES_DESCRIPTION).toMatch(TIMING);
  });

  it("capture is not consolidate and not capture_fact", () => {
    expect(CAPTURE_INFERENCE_DESCRIPTION).toMatch(/capture_fact/);
    expect(CAPTURE_INFERENCE_DESCRIPTION).toMatch(/consolidate/);
    expect(CAPTURE_INFERENCE_DESCRIPTION).toMatch(/not knowledge/i);
  });
});
