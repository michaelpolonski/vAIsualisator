import type {
  ActionNode,
  AppDefinition,
  EventLog,
  EventDefinition,
} from "@form-builder/contracts";
import { executePromptTask } from "../orchestrator/execute-prompt-task.js";
import type { LlmProvider } from "../orchestrator/types.js";
import { shapeToZod } from "./shape-to-zod.js";
import { topologicalSort } from "./topological-sort.js";

function resolveEvent(app: AppDefinition, eventId: string): EventDefinition {
  const event = app.events.find((item) => item.id === eventId);
  if (!event) {
    throw new Error(`Unknown event '${eventId}'.`);
  }
  return event;
}

function parseTransformExpression(
  expression: string,
  nodeOutputs: Record<string, unknown>,
): unknown {
  const match = expression.match(/^\[\$(.+?)\.output\]$/);
  if (!match) {
    return expression;
  }

  const nodeId = match[1];
  if (!nodeId) {
    return expression;
  }
  return [nodeOutputs[nodeId]];
}

async function runNode(
  node: ActionNode,
  state: Record<string, unknown>,
  nodeOutputs: Record<string, unknown>,
  providers: Record<string, LlmProvider>,
  logs: EventLog[],
  eventId: string,
  statePatch: Record<string, unknown>,
): Promise<void> {
  if (node.kind === "Validate") {
    for (const key of node.input.stateKeys) {
      const value = state[key];
      if (value === undefined || value === null || value === "") {
        throw new Error(`Validation failed: state key '${key}' is empty.`);
      }
    }
    logs.push({
      at: new Date().toISOString(),
      eventId,
      stage: "validate",
      message: `Validated ${node.input.stateKeys.length} state keys.`,
    });
    return;
  }

  if (node.kind === "PromptTask") {
    const variableMap: Record<string, unknown> = {};
    for (const variable of node.promptSpec.variables) {
      variableMap[variable] = state[variable];
    }

    const outputSchema = shapeToZod(node.promptSpec.outputSchema.shape);
    const result = await executePromptTask<Record<string, unknown>, Record<string, unknown>>(
      {
        template: node.promptSpec.template,
        variables: variableMap,
        outputSchema,
        modelPolicy: node.promptSpec.modelPolicy,
      },
      providers,
    );

    nodeOutputs[node.id] = result.output;
    logs.push({
      at: new Date().toISOString(),
      eventId,
      stage: "prompt",
      message: `PromptTask '${node.id}' executed via '${node.promptSpec.modelPolicy.provider}'.`,
    });
    return;
  }

  if (node.kind === "Transform") {
    for (const [key, expression] of Object.entries(node.mapToState)) {
      statePatch[key] = parseTransformExpression(expression, nodeOutputs);
    }
    logs.push({
      at: new Date().toISOString(),
      eventId,
      stage: "transform",
      message: `Mapped ${Object.keys(node.mapToState).length} outputs into state patch.`,
    });
  }
}

export async function executeEvent(
  app: AppDefinition,
  eventId: string,
  state: Record<string, unknown>,
  providers: Record<string, LlmProvider>,
): Promise<{ statePatch: Record<string, unknown>; logs: EventLog[] }> {
  const event = resolveEvent(app, eventId);
  const order = topologicalSort(
    event.actionGraph.nodes.map((node) => node.id),
    event.actionGraph.edges,
  );

  const nodeMap = new Map(event.actionGraph.nodes.map((node) => [node.id, node]));
  const logs: EventLog[] = [];
  const statePatch: Record<string, unknown> = {};
  const nodeOutputs: Record<string, unknown> = {};

  for (const nodeId of order) {
    const node = nodeMap.get(nodeId);
    if (!node) {
      throw new Error(`Node '${nodeId}' not found during execution.`);
    }

    await runNode(node, state, nodeOutputs, providers, logs, eventId, statePatch);
  }

  return { statePatch, logs };
}
