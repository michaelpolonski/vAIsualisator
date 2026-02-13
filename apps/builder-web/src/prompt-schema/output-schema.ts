export const DEFAULT_OUTPUT_SCHEMA_SHAPE: Record<string, unknown> = {
  sentiment: {
    type: "string",
    enum: ["positive", "neutral", "negative"],
  },
  reply: {
    type: "string",
    minLength: 1,
  },
};

export const DEFAULT_OUTPUT_SCHEMA_JSON = JSON.stringify(
  DEFAULT_OUTPUT_SCHEMA_SHAPE,
  null,
  2,
);

export interface OutputSchemaParseResult {
  shape: Record<string, unknown>;
  error?: string;
}

export function parseOutputSchemaShape(
  draft: string | undefined,
): OutputSchemaParseResult {
  if (!draft || draft.trim().length === 0) {
    return { shape: DEFAULT_OUTPUT_SCHEMA_SHAPE };
  }

  try {
    const parsed = JSON.parse(draft) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        shape: DEFAULT_OUTPUT_SCHEMA_SHAPE,
        error: "Output schema must be a JSON object shape.",
      };
    }

    return { shape: parsed as Record<string, unknown> };
  } catch (error) {
    return {
      shape: DEFAULT_OUTPUT_SCHEMA_SHAPE,
      error: `Output schema JSON parse error: ${(error as Error).message}`,
    };
  }
}
