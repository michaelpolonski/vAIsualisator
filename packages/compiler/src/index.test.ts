import { describe, expect, it } from "vitest";
import { AppCompiler } from "./index.js";

const validApp = {
  appId: "test_app",
  version: "1.0.0",
  ui: {
    components: [
      {
        id: "input_customer_complaint",
        type: "TextArea",
        label: "Customer Complaint",
        stateKey: "customerComplaint",
        props: { required: true, maxLength: 2000 },
      },
      {
        id: "btn_analyze",
        type: "Button",
        label: "Analyze",
        events: { onClick: "evt_analyze_click" },
      },
      {
        id: "table_results",
        type: "DataTable",
        label: "Analysis Result",
        dataKey: "analysisRows",
      },
    ],
  },
  stateModel: {
    customerComplaint: { type: "string", source: "ui.input_customer_complaint" },
    analysisRows: {
      type: "array",
      items: {
        type: "object",
        shape: {
          sentiment: { type: "string" },
          reply: { type: "string" },
        },
      },
    },
  },
  events: [
    {
      id: "evt_analyze_click",
      trigger: { componentId: "btn_analyze", event: "onClick" },
      actionGraph: {
        nodes: [
          { id: "n1", kind: "Validate", input: { stateKeys: ["customerComplaint"] } },
          {
            id: "n2",
            kind: "PromptTask",
            promptSpec: {
              template: "Analyze {{Customer Complaint}} and return JSON.",
              variables: ["Customer Complaint"],
              modelPolicy: { provider: "mock", model: "mock-v1", temperature: 0 },
              outputSchema: {
                type: "object",
                shape: {
                  sentiment: { type: "string" },
                  reply: { type: "string", minLength: 1 },
                },
              },
            },
          },
          { id: "n3", kind: "Transform", mapToState: { analysisRows: "[$n2.output]" } },
        ],
        edges: [
          { from: "n1", to: "n2" },
          { from: "n2", to: "n3" },
        ],
      },
    },
  ],
} as const;

describe("AppCompiler", () => {
  it("compiles valid app and emits artifacts", async () => {
    const compiler = new AppCompiler();
    const result = await compiler.compile({
      app: validApp,
      target: "node-fastify-react",
    });

    expect(result.diagnostics.filter((item) => item.severity === "error")).toHaveLength(0);
    expect(result.files.length).toBeGreaterThan(0);
    expect(result.docker.imageName).toBe("app-test_app");
  });

  it("returns diagnostics for unknown prompt variables", async () => {
    const compiler = new AppCompiler();
    const broken = {
      ...validApp,
      events: [
        {
          ...validApp.events[0],
          actionGraph: {
            ...validApp.events[0].actionGraph,
            nodes: validApp.events[0].actionGraph.nodes.map((node) =>
              node.kind === "PromptTask"
                ? {
                    ...node,
                    promptSpec: {
                      ...node.promptSpec,
                      template: "Analyze {{missingValue}}",
                      variables: ["missingValue"],
                    },
                  }
                : node,
            ),
          },
        },
      ],
    };

    const result = await compiler.compile({
      app: broken,
      target: "node-fastify-react",
    });

    expect(result.files).toHaveLength(0);
    expect(result.diagnostics.some((item) => item.code === "UNKNOWN_PROMPT_VARIABLE")).toBe(true);
  });
});
