import { describe, expect, it } from "vitest";
import { toAppDefinition } from "./to-app-definition.js";

describe("toAppDefinition", () => {
  it("canonicalizes prompt template variables from labels to state keys", () => {
    const app = toAppDefinition({
      appId: "test_app",
      version: "1.0.0",
      components: [
        {
          id: "input_customer_complaint",
          type: "TextArea",
          label: "Customer Complaint",
          position: { x: 0, y: 0 },
          stateKey: "customerComplaint",
        },
        {
          id: "btn_analyze",
          type: "Button",
          label: "Analyze",
          position: { x: 0, y: 0 },
          eventId: "evt_analyze_click",
          promptTemplate: "Take {{Customer Complaint}} and summarize.",
        },
      ],
      connections: [],
    });

    const event = app.events.find((e) => e.id === "evt_analyze_click");
    expect(event).toBeTruthy();
    const promptNode = event!.actionGraph.nodes.find((n) => n.kind === "PromptTask");
    expect(promptNode).toBeTruthy();
    expect(promptNode!.kind).toBe("PromptTask");
    if (promptNode!.kind !== "PromptTask") {
      throw new Error("unreachable");
    }

    expect(promptNode!.promptSpec.template).toContain("{{customerComplaint}}");
    expect(promptNode!.promptSpec.template).not.toContain("{{Customer Complaint}}");
  });
});

