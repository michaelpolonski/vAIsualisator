import { create } from "zustand";

export type BuilderComponentType = "TextArea" | "Button" | "DataTable";

export interface BuilderComponent {
  id: string;
  type: BuilderComponentType;
  label: string;
  stateKey?: string;
  dataKey?: string;
  eventId?: string;
  promptTemplate?: string;
}

interface BuilderState {
  appId: string;
  version: string;
  components: BuilderComponent[];
  selectedComponentId?: string;
  addComponent: (type: BuilderComponentType) => void;
  selectComponent: (id: string) => void;
  updateComponent: (id: string, patch: Partial<BuilderComponent>) => void;
}

let seq = 0;

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

export const useBuilderStore = create<BuilderState>((set) => ({
  appId: "app_customer_support_v1",
  version: "1.0.0",
  components: [
    {
      id: "input_customer_complaint",
      type: "TextArea",
      label: "Customer Complaint",
      stateKey: "customerComplaint",
    },
    {
      id: "btn_analyze",
      type: "Button",
      label: "Analyze",
      eventId: "evt_analyze_click",
      promptTemplate:
        "Take the text from {{customerComplaint}}, determine the sentiment, and suggest a polite reply.",
    },
    {
      id: "table_results",
      type: "DataTable",
      label: "Analysis Result",
      dataKey: "analysisRows",
    },
  ],
  addComponent: (type) => {
    seq += 1;
    const idBase = type.toLowerCase();
    if (type === "TextArea") {
      const label = `Input ${seq}`;
      set((state) => ({
        components: [
          ...state.components,
          {
            id: `${idBase}_${seq}`,
            type,
            label,
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
          dataKey: `tableData${seq}`,
        },
      ],
    }));
  },
  selectComponent: (id) => set({ selectedComponentId: id }),
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
}));

export function getPromptVariables(): string[] {
  return getStateSnapshot()
    .components.filter((component) => component.type === "TextArea")
    .map((component) => component.stateKey ?? "")
    .filter(Boolean);
}

export function getStateSnapshot(): BuilderState {
  return useBuilderStore.getState();
}
