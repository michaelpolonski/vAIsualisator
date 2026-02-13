import { useBuilderStore } from "../state/builder-store.js";

export function Canvas(): JSX.Element {
  const components = useBuilderStore((state) => state.components);
  const selectedId = useBuilderStore((state) => state.selectedComponentId);
  const select = useBuilderStore((state) => state.selectComponent);
  const update = useBuilderStore((state) => state.updateComponent);

  return (
    <section className="panel canvas">
      <h2>Canvas</h2>
      <div className="canvas-grid">
        {components.map((component) => (
          <div
            key={component.id}
            className={`component-card ${selectedId === component.id ? "selected" : ""}`}
            onClick={() => select(component.id)}
          >
            <label>
              Label
              <input
                value={component.label}
                onChange={(event) => update(component.id, { label: event.target.value })}
              />
            </label>
            <div className="meta">{component.type}</div>
            {component.type === "TextArea" && (
              <div className="meta">state: {component.stateKey}</div>
            )}
            {component.type === "Button" && <div className="meta">event: {component.eventId}</div>}
            {component.type === "DataTable" && <div className="meta">data: {component.dataKey}</div>}
          </div>
        ))}
      </div>
    </section>
  );
}
