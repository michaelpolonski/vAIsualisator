import { create } from "zustand";

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

interface BuilderState {
  appId: string;
  version: string;
  components: BuilderComponent[];
  connections: BuilderConnection[];
  selectedComponentId: string | undefined;
  addComponent: (type: BuilderComponentType, position?: BuilderPosition) => void;
  selectComponent: (id?: string) => void;
  updateComponent: (id: string, patch: Partial<BuilderComponent>) => void;
  moveComponent: (id: string, position: BuilderPosition) => void;
  addConnection: (sourceId: string, targetId: string) => void;
  removeConnection: (connectionId: string) => void;
}

let seq = 0;
const GRID_X = 320;
const GRID_Y = 120;

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

export const useBuilderStore = create<BuilderState>((set) => ({
  appId: "app_customer_support_v1",
  version: "1.0.0",
  selectedComponentId: undefined,
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
            stateKey: toStateKey(label),
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
            eventId: `evt_${idBase}_${seq}_click`,
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
          dataKey: `tableData${seq}`,
        },
      ],
    }));
  },
  selectComponent: (id) =>
    set(() =>
      id === undefined ? { selectedComponentId: undefined } : { selectedComponentId: id },
    ),
  updateComponent: (id, patch) =>
    set((state) => ({
      components: state.components.map((item) => {
        if (item.id !== id) {
          return item;
        }

        if (item.type === "TextArea") {
          const nextLabel = patch.label ?? item.label;
          return {
            ...item,
            ...patch,
            stateKey: patch.stateKey ?? toStateKey(nextLabel),
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
}));

export function getPromptVariables(buttonId?: string): string[] {
  const state = getStateSnapshot();
  const allInputKeys = state.components
    .filter((component) => component.type === "TextArea")
    .map((component) => component.stateKey ?? "")
    .filter(Boolean);

  if (!buttonId) {
    return allInputKeys;
  }

  const connectedInputKeys = state.connections
    .filter((connection) => connection.targetId === buttonId)
    .map((connection) => getComponentById(state.components, connection.sourceId))
    .filter((component): component is BuilderComponent => !!component)
    .filter((component) => component.type === "TextArea")
    .map((component) => component.stateKey ?? "")
    .filter(Boolean);

  return connectedInputKeys.length > 0 ? connectedInputKeys : allInputKeys;
}

export function getStateSnapshot(): BuilderState {
  return useBuilderStore.getState();
}
