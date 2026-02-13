import OpenAI from "openai";
import type { LlmProvider } from "../../orchestrator/types.js";

export class OpenAIProvider implements LlmProvider {
  private readonly client: OpenAI;

  constructor(apiKey: string) {
    this.client = new OpenAI({ apiKey });
  }

  async execute(req: {
    prompt: string;
    model: string;
    temperature?: number | undefined;
  }): Promise<{ text: string; meta: Record<string, unknown> }> {
    const completion = await this.client.responses.create({
      model: req.model,
      input: req.prompt,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    });

    const text = completion.output_text;
    return {
      text,
      meta: {
        id: completion.id,
        model: completion.model,
      },
    };
  }
}
