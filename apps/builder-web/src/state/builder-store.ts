import { create } from "zustand";
import type { AppDefinition } from "@form-builder/contracts";

export type BuilderComponentType = "TextArea" | "Button" | "DataTable";
export interface BuilderPosition {
  x: number;
  y: number;
}

export interface BuilderComponent {
  id: string;
  type: BuilderComponentType;
  label: string;
  position: BuilderPosition;
  stateKey?: string;
  dataKey?: string;
  eventId?: string;
  promptTemplate?: string;
}

export interface BuilderConnection {
  id: string;
  sourceId: string;
  targetId: string;
}

export interface BuilderWorkspaceSnapshot {
  appId: string;
  version: string;
  components: BuilderComponent[];
  connections: BuilderConnection[];
}

interface BuilderState {
  appId: string;
  version: string;
  components: BuilderComponent[];
  connections: BuilderConnection[];
  selectedComponentId: string | undefined;
  promptEditorFocusToken: number;
  addComponent: (type: BuilderComponentType, position?: BuilderPosition) => void;
  selectComponent: (id?: string) => void;
  focusPromptEditor: (buttonId: string) => void;
  updateComponent: (id: string, patch: Partial<BuilderComponent>) => void;
  moveComponent: (id: string, position: BuilderPosition) => void;
  addConnection: (sourceId: string, targetId: string) => void;
  removeConnection: (connectionId: string) => void;
  loadFromAppDefinition: (app: AppDefinition) => void;
  loadWorkspaceSnapshot: (snapshot: BuilderWorkspaceSnapshot) => void;
}

let seq = 0;
const GRID_X = 320;
const GRID_Y = 120;
const PROMPT_VAR_REGEX = /{{\s*([^}]+?)\s*}}/g;

function toStateKey(label: string): string {
  const tokens = label
    .trim()
    .replace(/[^a-zA-Z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);

  if (tokens.length === 0) {
    return "fieldValue";
  }

  return tokens
    .map((token, index) => {
      if (index === 0) {
        return token.toLowerCase();
      }
      return token.charAt(0).toUpperCase() + token.slice(1).toLowerCase();
    })
    .join("");
}

function toDataKey(label: string): string {
  return `${toStateKey(label)}Rows`;
}

function normalizeIdentifier(input: string, fallback: string): string {
  const trimmed = input.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function nextUniqueIdentifier(args: {
  preferred: string;
  fallback: string;
  used: Set<string>;
  joiner: "" | "_";
}): string {
  const base = normalizeIdentifier(args.preferred, args.fallback);
  if (!args.used.has(base)) {
    return base;
  }

  let index = 2;
  while (args.used.has(`${base}${args.joiner}${index}`)) {
    index += 1;
  }
  return `${base}${args.joiner}${index}`;
}

function collectUsedStateModelKeys(args: {
  components: BuilderComponent[];
  excludeComponentId?: string;
}): Set<string> {
  const used = new Set<string>();
  for (const component of args.components) {
    if (component.id === args.excludeComponentId) {
      continue;
    }
    if (component.type === "TextArea" && component.stateKey) {
      used.add(component.stateKey);
      continue;
    }
    if (component.type === "DataTable" && component.dataKey) {
      used.add(component.dataKey);
    }
  }
  return used;
}

function collectUsedEventIds(args: {
  components: BuilderComponent[];
  excludeComponentId?: string;
}): Set<string> {
  const used = new Set<string>();
  for (const component of args.components) {
    if (component.id === args.excludeComponentId || component.type !== "Button") {
      continue;
    }
    if (component.eventId) {
      used.add(component.eventId);
    }
  }
  return used;
}

function ensureUniqueStateModelKey(args: {
  components: BuilderComponent[];
  preferred: string;
  fallback: string;
  excludeComponentId?: string;
}): string {
  const used = collectUsedStateModelKeys(
    args.excludeComponentId
      ? {
          components: args.components,
          excludeComponentId: args.excludeComponentId,
        }
      : { components: args.components },
  );
  return nextUniqueIdentifier({
    preferred: args.preferred,
    fallback: args.fallback,
    used,
    joiner: "",
  });
}

function ensureUniqueEventId(args: {
  components: BuilderComponent[];
  preferred: string;
  fallback: string;
  excludeComponentId?: string;
}): string {
  const used = collectUsedEventIds(
    args.excludeComponentId
      ? {
          components: args.components,
          excludeComponentId: args.excludeComponentId,
        }
      : { components: args.components },
  );
  return nextUniqueIdentifier({
    preferred: args.preferred,
    fallback: args.fallback,
    used,
    joiner: "_",
  });
}

function normalizeLookupKey(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, "");
}

function getStateKeysFromComponents(components: BuilderComponent[]): string[] {
  return components
    .filter((component) => component.type === "TextArea")
    .map((component) => component.stateKey ?? "")
    .filter(Boolean);
}

function nextPosition(index: number): BuilderPosition {
  return {
    x: 30 + (index % 2) * GRID_X,
    y: 30 + Math.floor(index / 2) * GRID_Y,
  };
}

function getComponentById(
  components: BuilderComponent[],
  id: string,
): BuilderComponent | undefined {
  return components.find((component) => component.id === id);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isBuilderComponentType(value: unknown): value is BuilderComponentType {
  return value === "TextArea" || value === "Button" || value === "DataTable";
}

function parseSnapshotComponent(value: unknown): BuilderComponent | null {
  if (!isRecord(value)) {
    return null;
  }
  if (
    typeof value.id !== "string" ||
    !isBuilderComponentType(value.type) ||
    typeof value.label !== "string" ||
    !isRecord(value.position) ||
    typeof value.position.x !== "number" ||
    typeof value.position.y !== "number"
  ) {
    return null;
  }

  if (value.type === "TextArea") {
    const stateKey =
      typeof value.stateKey === "string" && value.stateKey.length > 0
        ? value.stateKey
        : toStateKey(value.label);
    return {
      id: value.id,
      type: "TextArea",
      label: value.label,
      position: { x: value.position.x, y: value.position.y },
      stateKey,
    };
  }

  if (value.type === "Button") {
    return {
      id: value.id,
      type: "Button",
      label: value.label,
      position: { x: value.position.x, y: value.position.y },
      eventId:
        typeof value.eventId === "string" && value.eventId.length > 0
          ? value.eventId
          : `evt_${value.id}_click`,
      ...(typeof value.promptTemplate === "string"
        ? { promptTemplate: value.promptTemplate }
        : {}),
    };
  }

  return {
    id: value.id,
    type: "DataTable",
    label: value.label,
    position: { x: value.position.x, y: value.position.y },
    dataKey:
      typeof value.dataKey === "string" && value.dataKey.length > 0
        ? value.dataKey
        : `${toStateKey(value.label)}Rows`,
  };
}

function parseSnapshotConnection(value: unknown): BuilderConnection | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.sourceId !== "string" ||
    typeof value.targetId !== "string"
  ) {
    return null;
  }

  return {
    id: value.id,
    sourceId: value.sourceId,
    targetId: value.targetId,
  };
}

function normalizeBuilderComponentIdentifiers(
  components: BuilderComponent[],
): BuilderComponent[] {
  const usedStateModelKeys = new Set<string>();
  const usedEventIds = new Set<string>();

  return components.map((component) => {
    if (component.type === "TextArea") {
      const stateKey = nextUniqueIdentifier({
        preferred: component.stateKey ?? toStateKey(component.label),
        fallback: "fieldValue",
        used: usedStateModelKeys,
        joiner: "",
      });
      usedStateModelKeys.add(stateKey);
      return {
        ...component,
        stateKey,
      };
    }

    if (component.type === "DataTable") {
      const dataKey = nextUniqueIdentifier({
        preferred: component.dataKey ?? toDataKey(component.label),
        fallback: "analysisRows",
        used: usedStateModelKeys,
        joiner: "",
      });
      usedStateModelKeys.add(dataKey);
      return {
        ...component,
        dataKey,
      };
    }

    const eventId = nextUniqueIdentifier({
      preferred: component.eventId ?? `evt_${component.id}_click`,
      fallback: `evt_${component.id}_click`,
      used: usedEventIds,
      joiner: "_",
    });
    usedEventIds.add(eventId);
    return {
      ...component,
      eventId,
    };
  });
}

export function parseBuilderWorkspaceSnapshot(
  value: unknown,
): BuilderWorkspaceSnapshot | null {
  if (
    !isRecord(value) ||
    typeof value.appId !== "string" ||
    typeof value.version !== "string" ||
    !Array.isArray(value.components) ||
    !Array.isArray(value.connections)
  ) {
    return null;
  }

  const components: BuilderComponent[] = [];
  for (const item of value.components) {
    const parsed = parseSnapshotComponent(item);
    if (!parsed) {
      continue;
    }
    components.push(parsed);
  }
  if (components.length === 0) {
    return null;
  }

  const normalizedComponents = normalizeBuilderComponentIdentifiers(components);

  const componentIds = new Set(normalizedComponents.map((component) => component.id));
  const connections: BuilderConnection[] = [];
  for (const item of value.connections) {
    const parsed = parseSnapshotConnection(item);
    if (!parsed) {
      continue;
    }
    if (!componentIds.has(parsed.sourceId) || !componentIds.has(parsed.targetId)) {
      continue;
    }
    if (
      !canConnectComponents({
        components: normalizedComponents,
        sourceId: parsed.sourceId,
        targetId: parsed.targetId,
      })
    ) {
      continue;
    }
    connections.push(parsed);
  }

  return {
    appId: value.appId,
    version: value.version,
    components: normalizedComponents,
    connections: dedupeConnections(connections),
  };
}

function dedupeConnections(connections: BuilderConnection[]): BuilderConnection[] {
  const seen = new Set<string>();
  const deduped: BuilderConnection[] = [];

  for (const connection of connections) {
    const key = `${connection.sourceId}::${connection.targetId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(connection);
  }

  return deduped;
}

function buildBuilderFromAppDefinition(app: AppDefinition): {
  components: BuilderComponent[];
  connections: BuilderConnection[];
} {
  const components: BuilderComponent[] = app.ui.components.map((component, index) => {
    if (component.type === "TextArea") {
      return {
        id: component.id,
        type: "TextArea",
        label: component.label,
        position: nextPosition(index),
        stateKey: component.stateKey,
      };
    }

    if (component.type === "Button") {
      return {
        id: component.id,
        type: "Button",
        label: component.label,
        position: nextPosition(index),
        eventId: component.events.onClick ?? `evt_${component.id}_click`,
        promptTemplate: "",
      };
    }

    return {
      id: component.id,
      type: "DataTable",
      label: component.label,
      position: nextPosition(index),
      dataKey: component.dataKey,
    };
  });

  const componentsById = new Map(components.map((component) => [component.id, component]));
  const textAreasByStateKey = new Map(
    components
      .filter((component) => component.type === "TextArea")
      .map((component) => [component.stateKey ?? "", component.id]),
  );
  const dataTablesByDataKey = new Map(
    components
      .filter((component) => component.type === "DataTable")
      .map((component) => [component.dataKey ?? "", component.id]),
  );

  const connections: BuilderConnection[] = [];

  for (const event of app.events) {
    const button = componentsById.get(event.trigger.componentId);
    if (!button || button.type !== "Button") {
      continue;
    }

    button.eventId = event.id;
    const promptNode = event.actionGraph.nodes.find((node) => node.kind === "PromptTask");
    if (promptNode && promptNode.kind === "PromptTask") {
      button.promptTemplate = promptNode.promptSpec.template;
    }

    const inputStateKeys = new Set<string>();
    const outputStateKeys = new Set<string>();

    for (const node of event.actionGraph.nodes) {
      if (node.kind === "Validate") {
        for (const key of node.input.stateKeys) {
          inputStateKeys.add(key);
        }
      }
      if (node.kind === "PromptTask") {
        for (const key of node.promptSpec.variables) {
          inputStateKeys.add(key);
        }
      }
      if (node.kind === "Transform") {
        for (const key of Object.keys(node.mapToState)) {
          outputStateKeys.add(key);
        }
      }
    }

    for (const stateKey of inputStateKeys) {
      const sourceId = textAreasByStateKey.get(stateKey);
      if (!sourceId) {
        continue;
      }
      connections.push({
        id: `conn_${sourceId}_${button.id}`,
        sourceId,
        targetId: button.id,
      });
    }

    for (const stateKey of outputStateKeys) {
      const targetId = dataTablesByDataKey.get(stateKey);
      if (!targetId) {
        continue;
      }
      connections.push({
        id: `conn_${button.id}_${targetId}`,
        sourceId: button.id,
        targetId,
      });
    }
  }

  return {
    components: normalizeBuilderComponentIdentifiers(components),
    connections: dedupeConnections(connections),
  };
}

export function canConnectComponents(args: {
  components: BuilderComponent[];
  sourceId: string;
  targetId: string;
}): boolean {
  if (args.sourceId === args.targetId) {
    return false;
  }

  const source = getComponentById(args.components, args.sourceId);
  const target = getComponentById(args.components, args.targetId);
  if (!source || !target) {
    return false;
  }

  if (source.type === "TextArea" && target.type === "Button") {
    return true;
  }

  if (source.type === "Button" && target.type === "DataTable") {
    return true;
  }

  return false;
}

function resolveConnectedInputKeys(args: {
  components: BuilderComponent[];
  connections: BuilderConnection[];
  buttonId: string;
}): string[] {
  const allInputKeys = getStateKeysFromComponents(args.components);

  const connectedInputKeys = args.connections
    .filter((connection) => connection.targetId === args.buttonId)
    .map((connection) => getComponentById(args.components, connection.sourceId))
    .filter((component): component is BuilderComponent => !!component)
    .filter((component) => component.type === "TextArea")
    .map((component) => component.stateKey ?? "")
    .filter(Boolean);

  return connectedInputKeys.length > 0 ? connectedInputKeys : allInputKeys;
}

function buildPromptAliasMap(components: BuilderComponent[]): Map<string, string> {
  const aliasMap = new Map<string, string>();

  for (const component of components) {
    if (component.type !== "TextArea" || !component.stateKey) {
      continue;
    }

    aliasMap.set(component.stateKey, component.stateKey);
    aliasMap.set(component.label, component.stateKey);
    aliasMap.set(normalizeLookupKey(component.stateKey), component.stateKey);
    aliasMap.set(normalizeLookupKey(component.label), component.stateKey);
  }

  return aliasMap;
}

function extractTemplateVariables(template: string): string[] {
  const variables: string[] = [];
  for (const match of template.matchAll(PROMPT_VAR_REGEX)) {
    const raw = match[1]?.trim();
    if (raw) {
      variables.push(raw);
    }
  }
  return variables;
}

export interface PromptDiagnostics {
  templateVariables: string[];
  unknownVariables: string[];
  disconnectedVariables: string[];
  availableVariables: string[];
}

export function getPromptDiagnosticsForButton(args: {
  components: BuilderComponent[];
  connections: BuilderConnection[];
  buttonId: string;
}): PromptDiagnostics {
  const button = getComponentById(args.components, args.buttonId);
  const template = button?.type === "Button" ? button.promptTemplate ?? "" : "";

  const allInputKeys = getStateKeysFromComponents(args.components);
  const availableVariables = resolveConnectedInputKeys({
    components: args.components,
    connections: args.connections,
    buttonId: args.buttonId,
  });
  const aliases = buildPromptAliasMap(args.components);
  const templateVariables = extractTemplateVariables(template);
  const unknown = new Set<string>();
  const disconnected = new Set<string>();

  for (const token of templateVariables) {
    const canonical =
      aliases.get(token) ?? aliases.get(normalizeLookupKey(token)) ?? token;
    if (!allInputKeys.includes(canonical)) {
      unknown.add(token);
      continue;
    }

    if (!availableVariables.includes(canonical)) {
      disconnected.add(canonical);
    }
  }

  return {
    templateVariables,
    unknownVariables: [...unknown],
    disconnectedVariables: [...disconnected],
    availableVariables,
  };
}

export const useBuilderStore = create<BuilderState>((set) => ({
  appId: "app_customer_support_v1",
  version: "1.0.0",
  selectedComponentId: undefined,
  promptEditorFocusToken: 0,
  components: [
    {
      id: "input_customer_complaint",
      type: "TextArea",
      label: "Customer Complaint",
      position: { x: 30, y: 30 },
      stateKey: "customerComplaint",
    },
    {
      id: "btn_analyze",
      type: "Button",
      label: "Analyze",
      position: { x: 350, y: 30 },
      eventId: "evt_analyze_click",
      promptTemplate:
        "Take the text from {{customerComplaint}}, determine the sentiment, and suggest a polite reply.",
    },
    {
      id: "table_results",
      type: "DataTable",
      label: "Analysis Result",
      position: { x: 350, y: 180 },
      dataKey: "analysisRows",
    },
  ],
  connections: [
    {
      id: "conn_input_to_btn",
      sourceId: "input_customer_complaint",
      targetId: "btn_analyze",
    },
    {
      id: "conn_btn_to_table",
      sourceId: "btn_analyze",
      targetId: "table_results",
    },
  ],
  addComponent: (type, position) => {
    seq += 1;
    const idBase = type.toLowerCase();
    const resolvedPosition = position ?? nextPosition(getStateSnapshot().components.length);
    if (type === "TextArea") {
      const label = `Input ${seq}`;
      set((state) => ({
        components: [
          ...state.components,
          {
            id: `${idBase}_${seq}`,
            type,
            label,
            position: resolvedPosition,
            stateKey: ensureUniqueStateModelKey({
              components: state.components,
              preferred: toStateKey(label),
              fallback: "fieldValue",
            }),
          },
        ],
      }));
      return;
    }

    if (type === "Button") {
      set((state) => ({
        components: [
          ...state.components,
          {
            id: `${idBase}_${seq}`,
            type,
            label: `Button ${seq}`,
            position: resolvedPosition,
            eventId: ensureUniqueEventId({
              components: state.components,
              preferred: `evt_${idBase}_${seq}_click`,
              fallback: `evt_${idBase}_${seq}_click`,
            }),
            promptTemplate: "",
          },
        ],
      }));
      return;
    }

    set((state) => ({
      components: [
        ...state.components,
        {
          id: `${idBase}_${seq}`,
          type,
          label: `Table ${seq}`,
          position: resolvedPosition,
          dataKey: ensureUniqueStateModelKey({
            components: state.components,
            preferred: `tableData${seq}`,
            fallback: "analysisRows",
          }),
        },
      ],
    }));
  },
  selectComponent: (id) =>
    set(() =>
      id === undefined ? { selectedComponentId: undefined } : { selectedComponentId: id },
    ),
  focusPromptEditor: (buttonId) =>
    set((state) => ({
      selectedComponentId: buttonId,
      promptEditorFocusToken: state.promptEditorFocusToken + 1,
    })),
  updateComponent: (id, patch) =>
    set((state) => ({
      components: state.components.map((item) => {
        if (item.id !== id) {
          return item;
        }

        if (item.type === "TextArea") {
          const nextLabel = patch.label ?? item.label;
          const wantsGeneratedStateKey =
            patch.stateKey === undefined && patch.label !== undefined;
          const preferredStateKey = wantsGeneratedStateKey
            ? toStateKey(nextLabel)
            : patch.stateKey ?? item.stateKey ?? toStateKey(nextLabel);
          return {
            ...item,
            ...patch,
            stateKey: ensureUniqueStateModelKey({
              components: state.components,
              preferred: preferredStateKey,
              fallback: "fieldValue",
              excludeComponentId: item.id,
            }),
          };
        }

        if (item.type === "DataTable") {
          const preferredDataKey = patch.dataKey ?? item.dataKey ?? toDataKey(item.label);
          return {
            ...item,
            ...patch,
            dataKey: ensureUniqueStateModelKey({
              components: state.components,
              preferred: preferredDataKey,
              fallback: "analysisRows",
              excludeComponentId: item.id,
            }),
          };
        }

        if (item.type === "Button") {
          const preferredEventId = patch.eventId ?? item.eventId ?? `evt_${item.id}_click`;
          return {
            ...item,
            ...patch,
            eventId: ensureUniqueEventId({
              components: state.components,
              preferred: preferredEventId,
              fallback: `evt_${item.id}_click`,
              excludeComponentId: item.id,
            }),
          };
        }

        return {
          ...item,
          ...patch,
        };
      }),
    })),
  moveComponent: (id, position) =>
    set((state) => ({
      components: state.components.map((item) =>
        item.id === id
          ? {
              ...item,
              position,
            }
          : item,
      ),
    })),
  addConnection: (sourceId, targetId) =>
    set((state) => {
      if (
        !canConnectComponents({
          components: state.components,
          sourceId,
          targetId,
        })
      ) {
        return {};
      }

      const duplicate = state.connections.some(
        (connection) =>
          connection.sourceId === sourceId && connection.targetId === targetId,
      );
      if (duplicate) {
        return {};
      }

      const source = getComponentById(state.components, sourceId);
      const target = getComponentById(state.components, targetId);
      if (!source || !target) {
        return {};
      }

      let nextConnections = state.connections;

      if (source.type === "Button" && target.type === "DataTable") {
        nextConnections = nextConnections.filter(
          (connection) =>
            !(connection.sourceId === sourceId &&
              getComponentById(state.components, connection.targetId)?.type ===
                "DataTable"),
        );
      }

      return {
        connections: [
          ...nextConnections,
          {
            id: `conn_${sourceId}_${targetId}`,
            sourceId,
            targetId,
          },
        ],
      };
    }),
  removeConnection: (connectionId) =>
    set((state) => ({
      connections: state.connections.filter(
        (connection) => connection.id !== connectionId,
      ),
    })),
  loadFromAppDefinition: (app) => {
    const next = buildBuilderFromAppDefinition(app);
    const normalizedComponents = normalizeBuilderComponentIdentifiers(next.components);
    seq = Math.max(seq, normalizedComponents.length);
    set({
      appId: app.appId,
      version: app.version,
      components: normalizedComponents,
      connections: next.connections,
      selectedComponentId: undefined,
      promptEditorFocusToken: 0,
    });
  },
  loadWorkspaceSnapshot: (snapshot) => {
    const normalizedComponents = normalizeBuilderComponentIdentifiers(
      snapshot.components,
    );
    seq = Math.max(seq, normalizedComponents.length);
    set({
      appId: snapshot.appId,
      version: snapshot.version,
      components: normalizedComponents,
      connections: snapshot.connections,
      selectedComponentId: undefined,
      promptEditorFocusToken: 0,
    });
  },
}));

export function getPromptVariables(buttonId?: string): string[] {
  const state = getStateSnapshot();
  const allInputKeys = getStateKeysFromComponents(state.components);

  if (!buttonId) {
    return allInputKeys;
  }

  return resolveConnectedInputKeys({
    components: state.components,
    connections: state.connections,
    buttonId,
  });
}

export function getPromptDiagnostics(buttonId: string): PromptDiagnostics {
  const state = getStateSnapshot();
  return getPromptDiagnosticsForButton({
    components: state.components,
    connections: state.connections,
    buttonId,
  });
}

export function getStateSnapshot(): BuilderState {
  return useBuilderStore.getState();
}

export function getWorkspaceSnapshot(): BuilderWorkspaceSnapshot {
  const state = getStateSnapshot();
  return {
    appId: state.appId,
    version: state.version,
    components: state.components,
    connections: state.connections,
  };
}
