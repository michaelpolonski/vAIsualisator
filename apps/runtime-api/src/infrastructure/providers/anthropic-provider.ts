import Anthropic from "@anthropic-ai/sdk";
import type { LlmProvider } from "../../orchestrator/types.js";

export class AnthropicProvider implements LlmProvider {
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async execute(req: {
    prompt: string;
    model: string;
    temperature?: number | undefined;
  }): Promise<{ text: string; meta: Record<string, unknown> }> {
    const completion = await this.client.messages.create({
      model: req.model,
      max_tokens: 600,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      messages: [{ role: "user", content: req.prompt }],
    });

    const first = completion.content[0];
    const text = first && first.type === "text" ? first.text : "{}";

    return {
      text,
      meta: {
        id: completion.id,
        model: completion.model,
      },
    };
  }
}
