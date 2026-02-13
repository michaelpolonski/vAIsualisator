const TEMPLATE_TOKEN_REGEX = /{{\s*([^}]+?)\s*}}/g;

export function interpolateTemplate(
  template: string,
  variables: Record<string, unknown>,
): string {
  return template.replace(TEMPLATE_TOKEN_REGEX, (_match, rawKey: string) => {
    const key = String(rawKey).trim();
    if (!(key in variables)) {
      throw new Error(`Missing template variable '${key}'.`);
    }

    const value = variables[key];
    if (typeof value === "string") {
      return value;
    }

    return JSON.stringify(value);
  });
}
