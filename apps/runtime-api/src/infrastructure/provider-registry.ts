import { AnthropicProvider } from "./providers/anthropic-provider.js";
import { MockProvider } from "./providers/mock-provider.js";
import { OpenAIProvider } from "./providers/openai-provider.js";
import type { LlmProvider } from "../orchestrator/types.js";

export interface ProviderStatus {
  available: boolean;
  reason: string | null;
}

export interface ProviderStatusSnapshot {
  mock: ProviderStatus;
  openai: ProviderStatus;
  anthropic: ProviderStatus;
}

export function createProviderRegistry(env: NodeJS.ProcessEnv): Record<string, LlmProvider> {
  const providers: Record<string, LlmProvider> = {
    mock: new MockProvider(),
  };

  if (env.OPENAI_API_KEY) {
    providers.openai = new OpenAIProvider(env.OPENAI_API_KEY);
  }

  if (env.ANTHROPIC_API_KEY) {
    providers.anthropic = new AnthropicProvider(env.ANTHROPIC_API_KEY);
  }

  return providers;
}

export function getProviderStatusSnapshot(
  env: NodeJS.ProcessEnv,
): ProviderStatusSnapshot {
  return {
    mock: { available: true, reason: null },
    openai: env.OPENAI_API_KEY
      ? { available: true, reason: null }
      : { available: false, reason: "OPENAI_API_KEY is not set." },
    anthropic: env.ANTHROPIC_API_KEY
      ? { available: true, reason: null }
      : { available: false, reason: "ANTHROPIC_API_KEY is not set." },
  };
}
