import { getPromptVariables, useBuilderStore } from "../state/builder-store.js";

export function PromptEditor(): JSX.Element {
  const selectedId = useBuilderStore((state) => state.selectedComponentId);
  const components = useBuilderStore((state) => state.components);
  const update = useBuilderStore((state) => state.updateComponent);

  const selected = components.find((item) => item.id === selectedId);
  const variables = getPromptVariables();

  if (!selected || selected.type !== "Button") {
    return (
      <aside className="panel">
        <h2>Prompt Editor</h2>
        <p>Select a Button on the canvas to edit event prompt logic.</p>
      </aside>
    );
  }

  return (
    <aside className="panel">
      <h2>Prompt Editor</h2>
      <p>Event: {selected.eventId}</p>
      <textarea
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
    </aside>
  );
}
