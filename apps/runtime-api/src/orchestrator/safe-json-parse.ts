export function safeJsonParse(input: string): unknown {
  try {
    return JSON.parse(input);
  } catch (error) {
    throw new Error(`Provider response is not valid JSON: ${(error as Error).message}`);
  }
}
