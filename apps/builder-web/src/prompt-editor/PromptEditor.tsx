import { useEffect, useRef } from "react";
import {
  getPromptDiagnostics,
  getPromptVariables,
  useBuilderStore,
} from "../state/builder-store.js";

export function PromptEditor(): JSX.Element {
  const selectedId = useBuilderStore((state) => state.selectedComponentId);
  const promptEditorFocusToken = useBuilderStore(
    (state) => state.promptEditorFocusToken,
  );
  const components = useBuilderStore((state) => state.components);
  const update = useBuilderStore((state) => state.updateComponent);

  const selected = components.find((item) => item.id === selectedId);
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
    </aside>
  );
}
