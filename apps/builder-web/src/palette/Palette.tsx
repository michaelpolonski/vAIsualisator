import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import {
  useBuilderStore,
  type BuilderComponentType,
} from "../state/builder-store.js";

const types: BuilderComponentType[] = ["TextArea", "Button", "DataTable"];

function PaletteItem(props: { type: BuilderComponentType }): JSX.Element {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `palette-${props.type}`,
    data: {
      componentType: props.type,
    },
  });

  return (
    <button
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={`palette-item ${isDragging ? "dragging" : ""}`}
      style={{
        transform: CSS.Translate.toString(transform),
      }}
      type="button"
    >
      {props.type}
    </button>
  );
}

export function Palette(): JSX.Element {
  const addComponent = useBuilderStore((state) => state.addComponent);

  return (
    <aside className="panel">
      <h2>Palette</h2>
      <p className="hint">Drag components into the canvas.</p>
      <div className="palette-list">
        {types.map((type) => (
          <PaletteItem key={type} type={type} />
        ))}
      </div>
      <div className="quick-add">
        <div className="meta">Quick add</div>
        {types.map((type) => (
          <button key={type} className="block-button" onClick={() => addComponent(type)}>
            Add {type}
          </button>
        ))}
      </div>
    </aside>
  );
}
