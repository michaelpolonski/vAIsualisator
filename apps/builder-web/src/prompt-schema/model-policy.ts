export type SupportedModelProvider = "openai" | "anthropic" | "mock";

const SUPPORTED_MODEL_PROVIDERS: SupportedModelProvider[] = [
  "openai",
  "anthropic",
  "mock",
];

const DEFAULT_MODEL_BY_PROVIDER: Record<SupportedModelProvider, string> = {
  openai: "gpt-4o-mini",
  anthropic: "claude-3-5-haiku-latest",
  mock: "mock-v1",
};

export const DEFAULT_MODEL_POLICY = {
  provider: "mock" as SupportedModelProvider,
  model: "mock-v1",
  temperature: 0.2,
};

export interface ParsedModelPolicy {
  provider: SupportedModelProvider;
  model: string;
  temperature: number;
}

export interface ParseModelPolicyArgs {
  provider?: string | undefined;
  model?: string | undefined;
  temperature?: string | undefined;
}

export interface ParseModelPolicyResult {
  policy: ParsedModelPolicy;
  errors: string[];
}

export function isSupportedModelProvider(
  value: string | undefined,
): value is SupportedModelProvider {
  return (
    typeof value === "string" &&
    SUPPORTED_MODEL_PROVIDERS.includes(value as SupportedModelProvider)
  );
}

export function getDefaultModelForProvider(provider: SupportedModelProvider): string {
  return DEFAULT_MODEL_BY_PROVIDER[provider];
}

export function parseModelPolicyDraft(
  args: ParseModelPolicyArgs,
): ParseModelPolicyResult {
  const errors: string[] = [];
  const provider = isSupportedModelProvider(args.provider)
    ? args.provider
    : DEFAULT_MODEL_POLICY.provider;

  const model = args.model?.trim() ?? "";
  const resolvedModel =
    model.length > 0 ? model : getDefaultModelForProvider(provider);
  if (model.length === 0) {
    errors.push("Model name is required.");
  }

  const temperatureDraft = args.temperature?.trim() ?? "";
  let temperature = DEFAULT_MODEL_POLICY.temperature;
  if (temperatureDraft.length > 0) {
    const parsed = Number(temperatureDraft);
    if (!Number.isFinite(parsed)) {
      errors.push("Temperature must be a valid number between 0 and 2.");
    } else if (parsed < 0 || parsed > 2) {
      errors.push("Temperature must be between 0 and 2.");
    } else {
      temperature = parsed;
    }
  }

  return {
    policy: {
      provider,
      model: resolvedModel,
      temperature,
    },
    errors,
  };
}
