import {
  AppDefinitionSchema,
  type AppDefinition,
  type EventDefinition,
  type UIComponent,
} from "@form-builder/contracts";
import type { Diagnostic } from "../types.js";

const VAR_TOKEN_REGEX = /{{\s*([^}]+?)\s*}}/g;

function normalizeKey(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, "");
}

function buildAliasMap(components: UIComponent[]): Map<string, string> {
  const aliases = new Map<string, string>();
  for (const component of components) {
    if (component.type === "TextArea") {
      aliases.set(normalizeKey(component.label), component.stateKey);
      aliases.set(normalizeKey(component.stateKey), component.stateKey);
      aliases.set(component.label, component.stateKey);
      aliases.set(component.stateKey, component.stateKey);
    }
  }
  return aliases;
}

function collectTemplateTokens(template: string): string[] {
  const tokens: string[] = [];
  for (const match of template.matchAll(VAR_TOKEN_REGEX)) {
    const raw = match[1];
    if (raw) {
      tokens.push(raw.trim());
    }
  }
  return tokens;
}

function validateGraph(event: EventDefinition, diagnostics: Diagnostic[]): void {
  const nodeIds = new Set<string>();
  for (const node of event.actionGraph.nodes) {
    if (nodeIds.has(node.id)) {
      diagnostics.push({
        code: "GRAPH_DUPLICATE_NODE_ID",
        severity: "error",
        path: `events.${event.id}.actionGraph.nodes.${node.id}`,
        message: `Duplicate action node id '${node.id}' in event '${event.id}'.`,
      });
    }
    nodeIds.add(node.id);
  }

  for (const edge of event.actionGraph.edges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
      diagnostics.push({
        code: "GRAPH_UNKNOWN_EDGE_NODE",
        severity: "error",
        path: `events.${event.id}.actionGraph.edges`,
        message: `Edge references unknown node(s) '${edge.from}' -> '${edge.to}' in event '${event.id}'.`,
      });
    }
  }

  const indegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const id of nodeIds) {
    indegree.set(id, 0);
    outgoing.set(id, []);
  }

  for (const edge of event.actionGraph.edges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) {
      continue;
    }
    outgoing.get(edge.from)?.push(edge.to);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }

  const queue = [...[...indegree.entries()].filter(([, count]) => count === 0).map(([id]) => id)];
  let visited = 0;
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      break;
    }
    visited += 1;
    const neighbors = outgoing.get(current) ?? [];
    for (const next of neighbors) {
      indegree.set(next, (indegree.get(next) ?? 0) - 1);
      if ((indegree.get(next) ?? 0) === 0) {
        queue.push(next);
      }
    }
  }

  if (visited !== nodeIds.size) {
    diagnostics.push({
      code: "GRAPH_CYCLE_DETECTED",
      severity: "error",
      path: `events.${event.id}.actionGraph`,
      message: `Action graph for event '${event.id}' contains a cycle.`,
    });
  }
}

export function parseAndValidate(input: unknown): {
  app?: AppDefinition;
  diagnostics: Diagnostic[];
} {
  const diagnostics: Diagnostic[] = [];
  const parsed = AppDefinitionSchema.safeParse(input);

  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      diagnostics.push({
        code: "SCHEMA_VALIDATION_ERROR",
        severity: "error",
        path: issue.path.join("."),
        message: issue.message,
      });
    }
    return { diagnostics };
  }

  const app = parsed.data;
  const componentIds = new Set<string>();
  const stateKeys = new Set(Object.keys(app.stateModel));
  const uiStateKeyOwners = new Map<string, string>();
  const triggerEventOwners = new Map<string, string>();
  const eventIds = new Set<string>();

  for (const component of app.ui.components) {
    if (componentIds.has(component.id)) {
      diagnostics.push({
        code: "DUPLICATE_COMPONENT_ID",
        severity: "error",
        path: `ui.components.${component.id}`,
        message: `Duplicate component id '${component.id}'.`,
      });
    }
    componentIds.add(component.id);

    if (component.type === "TextArea" && !stateKeys.has(component.stateKey)) {
      diagnostics.push({
        code: "MISSING_STATE_KEY",
        severity: "error",
        path: `ui.components.${component.id}.stateKey`,
        message: `TextArea component '${component.id}' references missing state key '${component.stateKey}'.`,
      });
    }

    if (component.type === "DataTable" && !stateKeys.has(component.dataKey)) {
      diagnostics.push({
        code: "MISSING_STATE_KEY",
        severity: "error",
        path: `ui.components.${component.id}.dataKey`,
        message: `DataTable component '${component.id}' references missing state key '${component.dataKey}'.`,
      });
    }

    if (component.type === "TextArea" || component.type === "DataTable") {
      const uiStateKey =
        component.type === "TextArea" ? component.stateKey : component.dataKey;
      const owner = uiStateKeyOwners.get(uiStateKey);
      if (owner && owner !== component.id) {
        diagnostics.push({
          code: "DUPLICATE_UI_STATE_KEY",
          severity: "error",
          path:
            component.type === "TextArea"
              ? `ui.components.${component.id}.stateKey`
              : `ui.components.${component.id}.dataKey`,
          message: `State key '${uiStateKey}' is used by both '${owner}' and '${component.id}'.`,
        });
      } else {
        uiStateKeyOwners.set(uiStateKey, component.id);
      }
    }

    if (component.type === "Button") {
      const eventId = component.events.onClick;
      if (!eventId) {
        continue;
      }
      const owner = triggerEventOwners.get(eventId);
      if (owner && owner !== component.id) {
        diagnostics.push({
          code: "DUPLICATE_TRIGGER_EVENT_ID",
          severity: "error",
          path: `ui.components.${component.id}.events.onClick`,
          message: `Button event id '${eventId}' is used by both '${owner}' and '${component.id}'.`,
        });
      } else {
        triggerEventOwners.set(eventId, component.id);
      }
    }
  }

  const aliases = buildAliasMap(app.ui.components);

  for (const event of app.events) {
    if (eventIds.has(event.id)) {
      diagnostics.push({
        code: "DUPLICATE_EVENT_ID",
        severity: "error",
        path: `events.${event.id}`,
        message: `Duplicate event id '${event.id}'.`,
      });
    }
    eventIds.add(event.id);

    if (!componentIds.has(event.trigger.componentId)) {
      diagnostics.push({
        code: "UNKNOWN_TRIGGER_COMPONENT",
        severity: "error",
        path: `events.${event.id}.trigger.componentId`,
        message: `Event '${event.id}' references unknown trigger component '${event.trigger.componentId}'.`,
      });
    }

    validateGraph(event, diagnostics);

    for (const node of event.actionGraph.nodes) {
      if (node.kind !== "PromptTask") {
        continue;
      }

      const tokens = collectTemplateTokens(node.promptSpec.template);
      for (const token of tokens) {
        const canonical = aliases.get(token) ?? aliases.get(normalizeKey(token)) ?? token;
        if (!stateKeys.has(canonical)) {
          diagnostics.push({
            code: "UNKNOWN_PROMPT_VARIABLE",
            severity: "error",
            path: `events.${event.id}.actionGraph.nodes.${node.id}.promptSpec.template`,
            message: `Prompt variable '{{${token}}}' does not map to a known state key.`,
          });
        }
      }

      for (const variable of node.promptSpec.variables) {
        const canonical = aliases.get(variable) ?? aliases.get(normalizeKey(variable)) ?? variable;
        if (!stateKeys.has(canonical)) {
          diagnostics.push({
            code: "UNKNOWN_PROMPT_VARIABLE",
            severity: "error",
            path: `events.${event.id}.actionGraph.nodes.${node.id}.promptSpec.variables`,
            message: `Prompt variable '${variable}' does not map to a known state key.`,
          });
        }
      }
    }
  }

  return { app, diagnostics };
}
