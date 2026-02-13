import { interpolateTemplate } from "./interpolate-template.js";
import { safeJsonParse } from "./safe-json-parse.js";
import type {
  LlmProvider,
  PromptExecutionRequest,
  PromptExecutionResult,
} from "./types.js";

export async function executePromptTask<
  TVars extends Record<string, unknown>,
  TOut,
>(
  req: PromptExecutionRequest<TVars>,
  providers: Record<string, LlmProvider>,
): Promise<PromptExecutionResult<TOut>> {
  const provider = providers[req.modelPolicy.provider];
  if (!provider) {
    throw new Error(`Unknown provider '${req.modelPolicy.provider}'.`);
  }

  const interpolated = interpolateTemplate(req.template, req.variables);
  const prompt = [
    "You are a strict JSON API.",
    "Return ONLY valid JSON.",
    interpolated,
  ].join("\n");

  const result = await provider.execute({
    prompt,
    model: req.modelPolicy.model,
    temperature: req.modelPolicy.temperature ?? 0,
    responseFormat: "json",
  });

  const json = safeJsonParse(result.text);
  const parsed = req.outputSchema.parse(json) as TOut;

  return {
    output: parsed,
    rawText: result.text,
    providerMeta: result.meta,
  };
}
