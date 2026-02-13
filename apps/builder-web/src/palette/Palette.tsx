import { useBuilderStore } from "../state/builder-store.js";

const types = ["TextArea", "Button", "DataTable"] as const;

export function Palette(): JSX.Element {
  const addComponent = useBuilderStore((state) => state.addComponent);

  return (
    <aside className="panel">
      <h2>Palette</h2>
      {types.map((type) => (
        <button key={type} onClick={() => addComponent(type)} className="block-button">
          Add {type}
        </button>
      ))}
      <p className="hint">MVP note: click-to-add is active; swap with drag/drop next.</p>
    </aside>
  );
}
