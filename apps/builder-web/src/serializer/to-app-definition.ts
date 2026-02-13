import type { AppDefinition } from "@form-builder/contracts";
import type {
  BuilderComponent,
  BuilderConnection,
} from "../state/builder-store.js";
import { parseOutputSchemaShape } from "../prompt-schema/output-schema.js";

function buildStateModel(components: BuilderComponent[]): AppDefinition["stateModel"] {
  const stateModel: AppDefinition["stateModel"] = {};

  for (const component of components) {
    if (component.type === "TextArea" && component.stateKey) {
      stateModel[component.stateKey] = {
        type: "string",
        source: `ui.${component.id}`,
      };
    }

    if (component.type === "DataTable" && component.dataKey) {
      stateModel[component.dataKey] = {
        type: "array",
        items: {
          type: "object",
          shape: {
            sentiment: { type: "string" },
            reply: { type: "string" },
          },
        },
      };
    }
  }

  return stateModel;
}

export function toAppDefinition(args: {
  appId: string;
  version: string;
  components: BuilderComponent[];
  connections: BuilderConnection[];
}): AppDefinition {
  const { appId, version, components, connections } = args;
  const uiComponents: AppDefinition["ui"]["components"] = [];
  const events: AppDefinition["events"] = [];
  const firstDataTable = components.find(
    (component) => component.type === "DataTable",
  );
  const componentById = new Map(components.map((item) => [item.id, item]));

  for (const component of components) {
    if (component.type === "TextArea") {
      uiComponents.push({
        id: component.id,
        type: "TextArea",
        label: component.label,
        stateKey: component.stateKey ?? "fieldValue",
        props: { required: true, maxLength: 2000 },
      });
    }

    if (component.type === "Button") {
      const eventId = component.eventId ?? `evt_${component.id}_click`;
      const connectedInputs = connections
        .filter((connection) => connection.targetId === component.id)
        .map((connection) => componentById.get(connection.sourceId))
        .filter((item): item is BuilderComponent => !!item)
        .filter((item) => item.type === "TextArea")
        .map((item) => item.stateKey ?? "")
        .filter(Boolean);
      const inputStateKeys =
        connectedInputs.length > 0
          ? connectedInputs
          : components
              .filter((item) => item.type === "TextArea")
              .map((item) => item.stateKey ?? "")
              .filter(Boolean);

      const outputConnection = connections
        .filter((connection) => connection.sourceId === component.id)
        .map((connection) => componentById.get(connection.targetId))
        .find((item): item is BuilderComponent => !!item && item.type === "DataTable");
      const outputDataKey =
        outputConnection?.dataKey ?? firstDataTable?.dataKey ?? "analysisRows";

      uiComponents.push({
        id: component.id,
        type: "Button",
        label: component.label,
        events: { onClick: eventId },
      });

      events.push({
        id: eventId,
        trigger: { componentId: component.id, event: "onClick" },
        actionGraph: {
          nodes: [
            {
              id: `${eventId}_validate`,
              kind: "Validate",
              input: {
                stateKeys: inputStateKeys,
              },
            },
            {
              id: `${eventId}_prompt`,
              kind: "PromptTask",
              promptSpec: {
                template:
                  component.promptTemplate && component.promptTemplate.length > 0
                    ? component.promptTemplate
                    : "Analyze {{customerComplaint}} and return sentiment and reply.",
                variables: inputStateKeys,
                modelPolicy: {
                  provider: "mock",
                  model: "mock-v1",
                  temperature: 0.2,
                },
                outputSchema: {
                  type: "object",
                  shape: parseOutputSchemaShape(component.outputSchemaJson).shape,
                },
              },
            },
            {
              id: `${eventId}_transform`,
              kind: "Transform",
              mapToState: {
                [outputDataKey]: `[$${eventId}_prompt.output]`,
              },
            },
          ],
          edges: [
            { from: `${eventId}_validate`, to: `${eventId}_prompt` },
            { from: `${eventId}_prompt`, to: `${eventId}_transform` },
          ],
        },
      });
    }

    if (component.type === "DataTable") {
      uiComponents.push({
        id: component.id,
        type: "DataTable",
        label: component.label,
        dataKey: component.dataKey ?? "analysisRows",
      });
    }
  }

  return {
    appId,
    version,
    ui: {
      components: uiComponents,
    },
    stateModel: {
      ...buildStateModel(components),
      ...(components.some((component) => component.type === "DataTable")
        ? {}
        : {
            [firstDataTable?.dataKey ?? "analysisRows"]: {
              type: "array" as const,
              items: {
                type: "object" as const,
                shape: {
                  sentiment: { type: "string" },
                  reply: { type: "string" },
                },
              },
            },
          }),
    },
    events,
  };
}
