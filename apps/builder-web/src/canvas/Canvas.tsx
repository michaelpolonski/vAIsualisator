import { useCallback, useEffect, useMemo, useState } from "react";
import { useDroppable } from "@dnd-kit/core";
import {
  MarkerType,
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Connection,
  type Edge,
  type Node,
  type NodeProps,
  type ReactFlowInstance,
} from "reactflow";
import {
  canConnectComponents,
  getPromptDiagnosticsForButton,
  useBuilderStore,
  type BuilderComponent,
} from "../state/builder-store.js";
import "reactflow/dist/style.css";

interface BuilderNodeData {
  component: BuilderComponent;
  selected: boolean;
  promptWarningCount: number;
  onSelect: (id: string) => void;
  onOpenPromptEditor: (id: string) => void;
  onUpdateLabel: (id: string, label: string) => void;
}

function BuilderNode({ data }: NodeProps<BuilderNodeData>): JSX.Element {
  const component = data.component;

  return (
    <div
      className={`flow-node ${data.selected ? "selected" : ""}`}
      onClick={() => data.onSelect(component.id)}
      onDoubleClick={() => {
        if (component.type === "Button") {
          data.onOpenPromptEditor(component.id);
        }
      }}
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
      {component.type === "Button" && (
        <>
          <div className="meta">event: {component.eventId}</div>
          <div className="meta">double-click to edit prompt</div>
          {data.promptWarningCount > 0 && (
            <div className="node-warning">
              {data.promptWarningCount} prompt issue{data.promptWarningCount > 1 ? "s" : ""}
            </div>
          )}
        </>
      )}
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
  const focusPromptEditor = useBuilderStore((state) => state.focusPromptEditor);
  const connections = useBuilderStore((state) => state.connections);
  const addConnection = useBuilderStore((state) => state.addConnection);
  const removeConnection = useBuilderStore((state) => state.removeConnection);
  const [flowInstance, setFlowInstance] = useState<ReactFlowInstance | null>(null);

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
      components.map((component) => {
        const promptDiagnostics =
          component.type === "Button"
            ? getPromptDiagnosticsForButton({
                components,
                connections,
                buttonId: component.id,
              })
            : undefined;

        return {
          id: component.id,
          type: "builderNode",
          position: component.position,
          data: {
            component,
            selected: selectedId === component.id,
            promptWarningCount: promptDiagnostics
              ? promptDiagnostics.unknownVariables.length +
                promptDiagnostics.disconnectedVariables.length +
                (promptDiagnostics.invalidOutputSchema ? 1 : 0)
              : 0,
            onSelect: (id: string) => selectComponent(id),
            onOpenPromptEditor: (id: string) => focusPromptEditor(id),
            onUpdateLabel: (id: string, label: string) => updateComponent(id, { label }),
          },
        };
      }),
    [
      components,
      connections,
      selectedId,
      selectComponent,
      focusPromptEditor,
      updateComponent,
    ],
  );

  const edges: Array<Edge> = useMemo(
    () =>
      connections.map((connection) => ({
        id: connection.id,
        source: connection.sourceId,
        target: connection.targetId,
        animated: false,
        markerEnd: { type: MarkerType.ArrowClosed },
      })),
    [connections],
  );

  const isValidConnection = useCallback(
    (connection: Connection): boolean => {
      const source = connection.source;
      const target = connection.target;
      if (!source || !target) {
        return false;
      }

      return canConnectComponents({
        components,
        sourceId: source,
        targetId: target,
      });
    },
    [components],
  );

  useEffect(() => {
    if (!flowInstance || !selectedId) {
      return;
    }

    const selected = components.find((component) => component.id === selectedId);
    if (!selected) {
      return;
    }

    flowInstance.setCenter(selected.position.x + 120, selected.position.y + 40, {
      zoom: Math.max(flowInstance.getZoom(), 0.9),
      duration: 280,
    });
  }, [components, flowInstance, selectedId]);

  return (
    <section ref={setCanvasRef} className={`panel canvas ${isOver ? "canvas-drop-over" : ""}`}>
      <h2>Canvas</h2>
      <div className="canvas-flow-wrap">
        <ReactFlow
          onInit={setFlowInstance}
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          fitView
          onNodeDragStop={(_event, node) => {
            moveComponent(node.id, node.position);
          }}
          onNodeClick={(_event, node) => {
            selectComponent(node.id);
          }}
          onPaneClick={() => selectComponent(undefined)}
          onConnect={(connection) => {
            if (!connection.source || !connection.target) {
              return;
            }
            addConnection(connection.source, connection.target);
          }}
          onEdgesDelete={(deletedEdges) => {
            for (const edge of deletedEdges) {
              removeConnection(edge.id);
            }
          }}
          isValidConnection={isValidConnection}
          deleteKeyCode={["Backspace", "Delete"]}
        >
          <Background gap={18} size={1} />
          <Controls />
        </ReactFlow>
      </div>
    </section>
  );
}
