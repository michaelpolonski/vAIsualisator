import { useMemo, useState } from "react";
import { DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { AppCompiler } from "@form-builder/compiler";
import { Palette } from "./palette/Palette.js";
import { Canvas } from "./canvas/Canvas.js";
import { PromptEditor } from "./prompt-editor/PromptEditor.js";
import { useBuilderStore, type BuilderComponentType } from "./state/builder-store.js";
import { toAppDefinition } from "./serializer/to-app-definition.js";
import "./styles.css";

function getClientPoint(event: Event): { x: number; y: number } | null {
  if (event instanceof MouseEvent || event instanceof PointerEvent) {
    return { x: event.clientX, y: event.clientY };
  }

  if (event instanceof TouchEvent && event.changedTouches.length > 0) {
    const touch = event.changedTouches.item(0);
    if (!touch) {
      return null;
    }
    return { x: touch.clientX, y: touch.clientY };
  }

  return null;
}

export function App(): JSX.Element {
  const appId = useBuilderStore((state) => state.appId);
  const version = useBuilderStore((state) => state.version);
  const components = useBuilderStore((state) => state.components);
  const addComponent = useBuilderStore((state) => state.addComponent);

  const [compileSummary, setCompileSummary] = useState<string>("");
  const [canvasElement, setCanvasElement] = useState<HTMLElement | null>(null);
  const sensors = useSensors(useSensor(PointerSensor));

  const schema = useMemo(
    () =>
      toAppDefinition({
        appId,
        version,
        components,
      }),
    [appId, version, components],
  );

  async function compileNow(): Promise<void> {
    const compiler = new AppCompiler();
    const result = await compiler.compile({
      app: schema,
      target: "node-fastify-react",
    });

    if (result.diagnostics.length > 0) {
      const message = result.diagnostics
        .map((item) => `${item.severity.toUpperCase()} ${item.code}: ${item.message}`)
        .join("\n");
      setCompileSummary(message);
      return;
    }

    setCompileSummary(
      `Compiled ${result.files.length} artifacts. Docker image: ${result.docker.imageName}:latest`,
    );
  }

  function onDragEnd(event: DragEndEvent): void {
    if (event.over?.id !== "builder-canvas") {
      return;
    }

    const componentType = event.active.data.current?.componentType as
      | BuilderComponentType
      | undefined;
    if (!componentType) {
      return;
    }

    if (!canvasElement || !(event.activatorEvent instanceof Event)) {
      addComponent(componentType);
      return;
    }

    const point = getClientPoint(event.activatorEvent);
    if (!point) {
      addComponent(componentType);
      return;
    }

    const rect = canvasElement.getBoundingClientRect();
    const dropX = point.x + event.delta.x - rect.left;
    const dropY = point.y + event.delta.y - rect.top;

    addComponent(componentType, {
      x: Math.max(20, dropX),
      y: Math.max(20, dropY),
    });
  }

  return (
    <DndContext sensors={sensors} onDragEnd={onDragEnd}>
      <main className="layout">
        <header className="header">
          <h1>Form-First AI Builder</h1>
          <button onClick={compileNow}>Run / Deploy (F5)</button>
        </header>

        <section className="workspace">
          <Palette />
          <Canvas onCanvasElementChange={setCanvasElement} />
          <PromptEditor />
        </section>

        <section className="panel">
          <h2>Current App Schema</h2>
          <pre>{JSON.stringify(schema, null, 2)}</pre>
        </section>

        <section className="panel">
          <h2>Compilation Output</h2>
          <pre>{compileSummary || "No compile run yet."}</pre>
        </section>
      </main>
    </DndContext>
  );
}
