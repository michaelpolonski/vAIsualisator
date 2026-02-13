import { useCallback, useEffect, useMemo } from "react";
import { useDroppable } from "@dnd-kit/core";
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Node,
  type NodeProps,
} from "reactflow";
import { useBuilderStore, type BuilderComponent } from "../state/builder-store.js";
import "reactflow/dist/style.css";

interface BuilderNodeData {
  component: BuilderComponent;
  selected: boolean;
  onSelect: (id: string) => void;
  onUpdateLabel: (id: string, label: string) => void;
}

function BuilderNode({ data }: NodeProps<BuilderNodeData>): JSX.Element {
  const component = data.component;

  return (
    <div
      className={`flow-node ${data.selected ? "selected" : ""}`}
      onClick={() => data.onSelect(component.id)}
    >
      {(component.type === "Button" || component.type === "DataTable") && (
        <Handle type="target" position={Position.Left} />
      )}
      <div className="meta">{component.type}</div>
      <input
        className="node-label-input"
        value={component.label}
        onChange={(event) => data.onUpdateLabel(component.id, event.target.value)}
        onClick={(event) => event.stopPropagation()}
      />
      {component.type === "TextArea" && <div className="meta">state: {component.stateKey}</div>}
      {component.type === "Button" && <div className="meta">event: {component.eventId}</div>}
      {component.type === "DataTable" && <div className="meta">data: {component.dataKey}</div>}
      {(component.type === "Button" || component.type === "TextArea") && (
        <Handle type="source" position={Position.Right} />
      )}
    </div>
  );
}

const nodeTypes = {
  builderNode: BuilderNode,
};

export function Canvas(props: {
  onCanvasElementChange: (element: HTMLElement | null) => void;
}): JSX.Element {
  const components = useBuilderStore((state) => state.components);
  const selectedId = useBuilderStore((state) => state.selectedComponentId);
  const selectComponent = useBuilderStore((state) => state.selectComponent);
  const updateComponent = useBuilderStore((state) => state.updateComponent);
  const moveComponent = useBuilderStore((state) => state.moveComponent);

  const { setNodeRef, isOver } = useDroppable({ id: "builder-canvas" });

  const setCanvasRef = useCallback(
    (element: HTMLElement | null) => {
      setNodeRef(element);
      props.onCanvasElementChange(element);
    },
    [props, setNodeRef],
  );

  useEffect(() => {
    return () => {
      props.onCanvasElementChange(null);
    };
  }, [props]);

  const nodes: Array<Node<BuilderNodeData>> = useMemo(
    () =>
      components.map((component) => ({
        id: component.id,
        type: "builderNode",
        position: component.position,
        data: {
          component,
          selected: selectedId === component.id,
          onSelect: (id: string) => selectComponent(id),
          onUpdateLabel: (id: string, label: string) => updateComponent(id, { label }),
        },
      })),
    [components, selectedId, selectComponent, updateComponent],
  );

  return (
    <section ref={setCanvasRef} className={`panel canvas ${isOver ? "canvas-drop-over" : ""}`}>
      <h2>Canvas</h2>
      <div className="canvas-flow-wrap">
        <ReactFlow
          nodes={nodes}
          edges={[]}
          nodeTypes={nodeTypes}
          fitView
          onNodeDragStop={(_event, node) => {
            moveComponent(node.id, node.position);
          }}
          onNodeClick={(_event, node) => {
            selectComponent(node.id);
          }}
          onPaneClick={() => selectComponent(undefined)}
        >
          <Background gap={18} size={1} />
          <Controls />
        </ReactFlow>
      </div>
    </section>
  );
}
