import { z, type ZodTypeAny } from "zod";

export function shapeToZod(shape: Record<string, unknown>): z.ZodObject<Record<string, ZodTypeAny>> {
  const fields: Record<string, ZodTypeAny> = {};

  for (const [key, descriptor] of Object.entries(shape)) {
    const rule = descriptor as Record<string, unknown>;
    const type = String(rule.type ?? "string");

    if (type === "string") {
      let stringSchema = z.string();
      if (typeof rule.minLength === "number") {
        stringSchema = stringSchema.min(rule.minLength);
      }
      if (typeof rule.maxLength === "number") {
        stringSchema = stringSchema.max(rule.maxLength);
      }

      let schema: ZodTypeAny = stringSchema;
      if (Array.isArray(rule.enum) && rule.enum.length > 0) {
        schema = stringSchema.refine((value) => (rule.enum as string[]).includes(value), {
          message: `Expected one of: ${(rule.enum as string[]).join(", ")}`,
        });
      }

      fields[key] = schema;
      continue;
    }

    if (type === "number") {
      fields[key] = z.number();
      continue;
    }

    if (type === "boolean") {
      fields[key] = z.boolean();
      continue;
    }

    fields[key] = z.unknown();
  }

  return z.object(fields);
}
