import { z } from "zod";

export const PrimitiveTypeSchema = z.enum(["string", "number", "boolean"]);

export const JsonShapeSchema = z.lazy(() => z.record(z.unknown()));

const PrimitiveStateFieldSchema = z.object({
  type: PrimitiveTypeSchema,
  source: z.string().optional(),
  enum: z.array(z.string()).optional(),
  minLength: z.number().int().nonnegative().optional(),
  maxLength: z.number().int().nonnegative().optional(),
});

const ArrayStateFieldSchema = z.object({
  type: z.literal("array"),
  source: z.string().optional(),
  items: z.object({
    type: z.literal("object"),
    shape: JsonShapeSchema,
  }),
});

export const StateFieldSchema = z.union([PrimitiveStateFieldSchema, ArrayStateFieldSchema]);

export const ModelPolicySchema = z.object({
  provider: z.enum(["openai", "anthropic", "mock"]),
  model: z.string().min(1),
  temperature: z.number().min(0).max(2).optional(),
});

export const PromptOutputSchema = z.object({
  type: z.literal("object"),
  shape: JsonShapeSchema,
});

export const PromptSpecSchema = z.object({
  template: z.string().min(1),
  variables: z.array(z.string().min(1)).default([]),
  modelPolicy: ModelPolicySchema,
  outputSchema: PromptOutputSchema,
});

export const ActionNodeSchema = z.discriminatedUnion("kind", [
  z.object({
    id: z.string().min(1),
    kind: z.literal("Validate"),
    input: z.object({
      stateKeys: z.array(z.string().min(1)).min(1),
    }),
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal("PromptTask"),
    promptSpec: PromptSpecSchema,
  }),
  z.object({
    id: z.string().min(1),
    kind: z.literal("Transform"),
    mapToState: z.record(z.string(), z.string()),
  }),
]);

export const ActionEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
});

export const ActionGraphSchema = z.object({
  nodes: z.array(ActionNodeSchema).min(1),
  edges: z.array(ActionEdgeSchema),
});

export const TriggerSchema = z.object({
  componentId: z.string().min(1),
  event: z.enum(["onClick", "onChange", "onSubmit"]),
});

export const EventDefinitionSchema = z.object({
  id: z.string().min(1),
  trigger: TriggerSchema,
  actionGraph: ActionGraphSchema,
});

const BaseComponentSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
});

export const UIComponentSchema = z.discriminatedUnion("type", [
  BaseComponentSchema.extend({
    type: z.literal("TextArea"),
    stateKey: z.string().min(1),
    props: z
      .object({
        required: z.boolean().optional(),
        maxLength: z.number().int().positive().optional(),
      })
      .default({}),
  }),
  BaseComponentSchema.extend({
    type: z.literal("Button"),
    events: z.record(z.string(), z.string()).default({}),
  }),
  BaseComponentSchema.extend({
    type: z.literal("DataTable"),
    dataKey: z.string().min(1),
  }),
]);

export const AppDefinitionSchema = z.object({
  appId: z.string().min(1),
  version: z.string().min(1),
  ui: z.object({
    components: z.array(UIComponentSchema).min(1),
  }),
  stateModel: z.record(z.string(), StateFieldSchema),
  events: z.array(EventDefinitionSchema),
});

export type AppDefinition = z.infer<typeof AppDefinitionSchema>;
export type UIComponent = z.infer<typeof UIComponentSchema>;
export type EventDefinition = z.infer<typeof EventDefinitionSchema>;
export type ActionNode = z.infer<typeof ActionNodeSchema>;
export type PromptSpec = z.infer<typeof PromptSpecSchema>;
