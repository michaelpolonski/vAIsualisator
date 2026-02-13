import type { LlmProvider } from "../../orchestrator/types.js";

export class MockProvider implements LlmProvider {
  async execute(): Promise<{ text: string; meta: Record<string, unknown> }> {
    return {
      text: JSON.stringify({
        sentiment: "neutral",
        reply:
          "Thank you for sharing this feedback. We are reviewing your concern and will follow up shortly.",
      }),
      meta: { provider: "mock" },
    };
  }
}
