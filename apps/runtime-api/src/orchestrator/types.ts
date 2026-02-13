import type { ZodSchema } from "zod";

export interface PromptExecutionRequest<TVars extends Record<string, unknown>> {
  template: string;
  variables: TVars;
  outputSchema: ZodSchema;
  modelPolicy: {
    provider: "openai" | "anthropic" | "mock";
    model: string;
    temperature?: number | undefined;
  };
}

export interface PromptExecutionResult<TOut> {
  output: TOut;
  rawText: string;
  providerMeta: Record<string, unknown>;
}

export interface LlmProvider {
  execute(req: {
    prompt: string;
    model: string;
    temperature?: number | undefined;
    responseFormat?: "json";
  }): Promise<{ text: string; meta: Record<string, unknown> }>;
}
