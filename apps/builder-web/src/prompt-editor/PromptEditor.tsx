import { useEffect, useRef } from "react";
import {
  getPromptDiagnostics,
  getPromptVariables,
  useBuilderStore,
} from "../state/builder-store.js";
import { DEFAULT_OUTPUT_SCHEMA_JSON } from "../prompt-schema/output-schema.js";
import {
  DEFAULT_MODEL_POLICY,
  getDefaultModelForProvider,
  getModelPresetsForProvider,
} from "../prompt-schema/model-policy.js";

export function PromptEditor(): JSX.Element {
  const selectedId = useBuilderStore((state) => state.selectedComponentId);
  const promptEditorFocusToken = useBuilderStore(
    (state) => state.promptEditorFocusToken,
  );
  const components = useBuilderStore((state) => state.components);
  const update = useBuilderStore((state) => state.updateComponent);

  const selected = components.find((item) => item.id === selectedId);
  const selectedProvider = selected?.modelProvider ?? DEFAULT_MODEL_POLICY.provider;
  const selectedModelName = selected?.modelName ?? DEFAULT_MODEL_POLICY.model;
  const modelPresets = getModelPresetsForProvider(selectedProvider);
  const editorRef = useRef<HTMLElement | null>(null);
  const textAreaRef = useRef<HTMLTextAreaElement | null>(null);
  const variables = getPromptVariables(selected?.type === "Button" ? selected.id : undefined);
  const diagnostics =
    selected?.type === "Button"
      ? getPromptDiagnostics(selected.id)
      : {
          unknownVariables: [],
          disconnectedVariables: [],
          templateVariables: [],
          availableVariables: [],
          invalidOutputSchema: null,
          invalidModelPolicy: [],
        };

  useEffect(() => {
    if (!selected || selected.type !== "Button") {
      return;
    }

    editorRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    textAreaRef.current?.focus();
  }, [selected?.id, selected?.type, promptEditorFocusToken]);

  if (!selected || selected.type !== "Button") {
    return (
      <aside className="panel">
        <h2>Prompt Editor</h2>
        <p>Select a Button on the canvas to edit event prompt logic.</p>
      </aside>
    );
  }

  return (
    <aside ref={editorRef} className="panel">
      <h2>Prompt Editor</h2>
      <p>Event: {selected.eventId}</p>
      <textarea
        ref={textAreaRef}
        className="prompt-input"
        value={selected.promptTemplate ?? ""}
        onChange={(event) =>
          update(selected.id, {
            promptTemplate: event.target.value,
          })
        }
        placeholder="Use variables like {{customerComplaint}}"
      />
      <div>
        <div className="meta">Available variables:</div>
        <div className="chips">
          {variables.map((variable) => (
            <button
              key={variable}
              className="chip"
              onClick={() =>
                update(selected.id, {
                  promptTemplate: `${selected.promptTemplate ?? ""} {{${variable}}}`.trim(),
                })
              }
            >
              {`{{${variable}}}`}
            </button>
          ))}
        </div>
      </div>
      {diagnostics.disconnectedVariables.length > 0 && (
        <div className="warning-box">
          <div className="warning-title">Disconnected Variables</div>
          <p className="warning-text">
            These variables exist but are not connected to this button:
          </p>
          <div className="chips">
            {diagnostics.disconnectedVariables.map((variable) => (
              <span key={variable} className="chip warning-chip">
                {`{{${variable}}}`}
              </span>
            ))}
          </div>
        </div>
      )}
      {diagnostics.unknownVariables.length > 0 && (
        <div className="warning-box">
          <div className="warning-title">Unknown Variables</div>
          <p className="warning-text">
            These placeholders do not map to any input field:
          </p>
          <div className="chips">
            {diagnostics.unknownVariables.map((variable) => (
              <span key={variable} className="chip warning-chip">
                {`{{${variable}}}`}
              </span>
            ))}
          </div>
        </div>
      )}
      <div>
        <div className="meta">Output schema (JSON shape):</div>
        <textarea
          className="prompt-input"
          value={selected.outputSchemaJson ?? DEFAULT_OUTPUT_SCHEMA_JSON}
          onChange={(event) =>
            update(selected.id, {
              outputSchemaJson: event.target.value,
            })
          }
          placeholder={DEFAULT_OUTPUT_SCHEMA_JSON}
        />
      </div>
      {diagnostics.invalidOutputSchema && (
        <div className="warning-box">
          <div className="warning-title">Invalid Output Schema</div>
          <p className="warning-text">{diagnostics.invalidOutputSchema}</p>
        </div>
      )}
      <div>
        <div className="meta">Model policy:</div>
        <div className="model-policy-grid">
          <label className="meta">
            Provider
            <select
              className="field-input"
              value={selectedProvider}
              onChange={(event) => {
                const nextProvider = event.target.value as
                  | "openai"
                  | "anthropic"
                  | "mock";
                const currentModel = selected.modelName?.trim() ?? "";
                update(selected.id, {
                  modelProvider: nextProvider,
                  modelName:
                    currentModel.length > 0
                      ? currentModel
                      : getDefaultModelForProvider(nextProvider),
                });
              }}
            >
              <option value="mock">mock</option>
              <option value="openai">openai</option>
              <option value="anthropic">anthropic</option>
            </select>
          </label>
          <label className="meta">
            Model
            <input
              className="field-input"
              value={selectedModelName}
              onChange={(event) =>
                update(selected.id, {
                  modelName: event.target.value,
                })
              }
              placeholder="model name"
            />
          </label>
          <div>
            <div className="meta">Presets</div>
            <div className="model-presets">
              {modelPresets.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  className={`model-preset-chip ${
                    selectedModelName.trim() === preset ? "active" : ""
                  }`}
                  onClick={() =>
                    update(selected.id, {
                      modelProvider: selectedProvider,
                      modelName: preset,
                    })
                  }
                >
                  {preset}
                </button>
              ))}
            </div>
          </div>
          <label className="meta">
            Temperature (0-2)
            <input
              className="field-input"
              value={selected.modelTemperature ?? String(DEFAULT_MODEL_POLICY.temperature)}
              onChange={(event) =>
                update(selected.id, {
                  modelTemperature: event.target.value,
                })
              }
              placeholder={String(DEFAULT_MODEL_POLICY.temperature)}
            />
          </label>
        </div>
      </div>
      {diagnostics.invalidModelPolicy.length > 0 && (
        <div className="warning-box">
          <div className="warning-title">Invalid Model Policy</div>
          <div className="warning-list">
            {diagnostics.invalidModelPolicy.map((error) => (
              <p key={error} className="warning-text">
                {error}
              </p>
            ))}
          </div>
        </div>
      )}
    </aside>
  );
}
