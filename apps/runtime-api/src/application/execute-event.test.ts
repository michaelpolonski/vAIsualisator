import { describe, expect, it } from "vitest";
import { executeEvent } from "./execute-event.js";
import { defaultApp } from "../domain/apps/default-app.js";
import { MockProvider } from "../infrastructure/providers/mock-provider.js";

describe("executeEvent", () => {
  it("runs prompt flow and returns state patch", async () => {
    const result = await executeEvent(
      defaultApp,
      "evt_analyze_click",
      { customerComplaint: "Your support response was slow." },
      { mock: new MockProvider() },
    );

    expect(Array.isArray(result.statePatch.analysisRows)).toBe(true);
    expect(result.logs.length).toBeGreaterThan(0);
  });

  it("fails validation when required input is empty", async () => {
    await expect(
      executeEvent(defaultApp, "evt_analyze_click", { customerComplaint: "" }, { mock: new MockProvider() }),
    ).rejects.toThrow("Validation failed");
  });
});
