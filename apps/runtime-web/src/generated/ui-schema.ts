import type { AppDefinition } from "@form-builder/contracts";

export const uiSchema: AppDefinition = {
  appId: "app_customer_support_v1",
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
          {
            id: "n1_validate",
            kind: "Validate",
            input: { stateKeys: ["customerComplaint"] },
          },
          {
            id: "n2_prompt",
            kind: "PromptTask",
            promptSpec: {
              template:
                "Take the text from {{customerComplaint}}, determine the sentiment, and suggest a polite reply.",
              variables: ["customerComplaint"],
              modelPolicy: { provider: "mock", model: "mock-v1", temperature: 0.2 },
              outputSchema: {
                type: "object",
                shape: {
                  sentiment: {
                    type: "string",
                    enum: ["positive", "neutral", "negative"],
                  },
                  reply: { type: "string", minLength: 1 },
                },
              },
            },
          },
          {
            id: "n3_transform",
            kind: "Transform",
            mapToState: { analysisRows: "[$n2_prompt.output]" },
          },
        ],
        edges: [
          { from: "n1_validate", to: "n2_prompt" },
          { from: "n2_prompt", to: "n3_transform" },
        ],
      },
    },
  ],
};
