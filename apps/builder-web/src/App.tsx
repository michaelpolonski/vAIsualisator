import { useCallback, useEffect, useMemo, useState, type ChangeEvent } from "react";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { AppCompiler } from "@form-builder/compiler";
import { AppDefinitionSchema, type AppDefinition } from "@form-builder/contracts";
import { Palette } from "./palette/Palette.js";
import { Canvas } from "./canvas/Canvas.js";
import { PromptEditor } from "./prompt-editor/PromptEditor.js";
import { useBuilderStore, type BuilderComponentType } from "./state/builder-store.js";
import { toAppDefinition } from "./serializer/to-app-definition.js";
import "./styles.css";

interface CompileDiagnostic {
  code: string;
  message: string;
  severity: "error" | "warning";
}

interface CompileFileMeta {
  path: string;
  bytes: number;
}

interface CompileFileContent {
  path: string;
  content: string;
}

interface BuilderCompileResponse {
  diagnostics: CompileDiagnostic[];
  docker: { imageName: string; tags: string[] };
  files: CompileFileMeta[];
  fileContents?: CompileFileContent[];
  generatedAt: string;
}

type CompileSource = "none" | "api" | "local";

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

function formatDiagnostics(diagnostics: CompileDiagnostic[]): string {
  if (diagnostics.length === 0) {
    return "";
  }

  return diagnostics
    .map((item) => `${item.severity.toUpperCase()} ${item.code}: ${item.message}`)
    .join("\n");
}

function createFileMetas(files: CompileFileContent[]): CompileFileMeta[] {
  return files.map((file) => ({
    path: file.path,
    bytes: new TextEncoder().encode(file.content).length,
  }));
}

function downloadJsonFile(filename: string, payload: unknown): void {
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

async function compileViaApi(args: {
  app: AppDefinition;
  includeFileContents?: boolean;
}): Promise<BuilderCompileResponse> {
  const apiBase = import.meta.env.VITE_BUILDER_API_URL ?? "http://localhost:3000";
  const response = await fetch(`${apiBase}/builder/compile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      app: args.app,
      target: "node-fastify-react",
      includeFileContents: args.includeFileContents ?? false,
    }),
  });

  const body = (await response.json()) as
    | BuilderCompileResponse
    | { error?: string; message?: string };

  if (!response.ok) {
    const message =
      "message" in body && body.message
        ? body.message
        : "error" in body && body.error
          ? body.error
          : "Compile API failed";
    throw new Error(message);
  }

  return body as BuilderCompileResponse;
}

async function compileLocally(args: {
  app: AppDefinition;
  includeFileContents?: boolean;
}): Promise<BuilderCompileResponse> {
  const compiler = new AppCompiler();
  const result = await compiler.compile({
    app: args.app,
    target: "node-fastify-react",
  });

  const fileContents: CompileFileContent[] = result.files.map((file) => ({
    path: file.path,
    content: file.content,
  }));

  return {
    diagnostics: result.diagnostics,
    docker: result.docker,
    files: createFileMetas(fileContents),
    ...(args.includeFileContents ? { fileContents } : {}),
    generatedAt: new Date().toISOString(),
  };
}

export function App(): JSX.Element {
  const appId = useBuilderStore((state) => state.appId);
  const version = useBuilderStore((state) => state.version);
  const components = useBuilderStore((state) => state.components);
  const connections = useBuilderStore((state) => state.connections);
  const addComponent = useBuilderStore((state) => state.addComponent);
  const loadFromAppDefinition = useBuilderStore(
    (state) => state.loadFromAppDefinition,
  );

  const [compileSummary, setCompileSummary] = useState<string>("No compile run yet.");
  const [compileFiles, setCompileFiles] = useState<CompileFileMeta[]>([]);
  const [compileSource, setCompileSource] = useState<CompileSource>("none");
  const [canvasElement, setCanvasElement] = useState<HTMLElement | null>(null);
  const sensors = useSensors(useSensor(PointerSensor));
  const [fileInputKey, setFileInputKey] = useState(0);

  const schema = useMemo(
    () =>
      toAppDefinition({
        appId,
        version,
        components,
        connections,
      }),
    [appId, version, components, connections],
  );

  const compileNow = useCallback(async (): Promise<void> => {
    setCompileSummary("Compiling...");

    try {
      const apiResult = await compileViaApi({ app: schema });
      const diagnosticsText = formatDiagnostics(apiResult.diagnostics);

      setCompileSource("api");
      setCompileFiles(apiResult.files);

      if (apiResult.diagnostics.some((item) => item.severity === "error")) {
        setCompileSummary(diagnosticsText || "Compilation failed with diagnostics.");
        return;
      }

      const warningSuffix = diagnosticsText ? `\n${diagnosticsText}` : "";
      setCompileSummary(
        `Compiled ${apiResult.files.length} artifacts via API. Docker image: ${apiResult.docker.imageName}:latest${warningSuffix}`,
      );
      return;
    } catch (apiError) {
      const localResult = await compileLocally({ app: schema });
      const diagnosticsText = formatDiagnostics(localResult.diagnostics);

      setCompileSource("local");
      setCompileFiles(localResult.files);

      if (localResult.diagnostics.some((item) => item.severity === "error")) {
        setCompileSummary(
          `Compile API unavailable (${(apiError as Error).message}). Local compile diagnostics:\n${diagnosticsText}`,
        );
        return;
      }

      const warningSuffix = diagnosticsText ? `\n${diagnosticsText}` : "";
      setCompileSummary(
        `Compiled ${localResult.files.length} artifacts locally (API fallback: ${(apiError as Error).message}). Docker image: ${localResult.docker.imageName}:latest${warningSuffix}`,
      );
    }
  }, [schema]);

  const exportBundle = useCallback(async (): Promise<void> => {
    setCompileSummary("Exporting generated bundle...");

    try {
      const apiResult = await compileViaApi({
        app: schema,
        includeFileContents: true,
      });
      const diagnosticsText = formatDiagnostics(apiResult.diagnostics);

      setCompileSource("api");
      setCompileFiles(apiResult.files);

      if (apiResult.diagnostics.some((item) => item.severity === "error")) {
        setCompileSummary(
          `Cannot export due to compile errors:\n${diagnosticsText}`,
        );
        return;
      }

      if (!apiResult.fileContents || apiResult.fileContents.length === 0) {
        setCompileSummary("Compile succeeded but no file contents were returned for export.");
        return;
      }

      downloadJsonFile(`${schema.appId}-bundle.json`, {
        appId: schema.appId,
        version: schema.version,
        appDefinition: schema,
        target: "node-fastify-react",
        source: "api",
        generatedAt: apiResult.generatedAt,
        docker: apiResult.docker,
        diagnostics: apiResult.diagnostics,
        files: apiResult.fileContents,
      });

      const warningSuffix = diagnosticsText ? `\n${diagnosticsText}` : "";
      setCompileSummary(
        `Exported bundle with ${apiResult.fileContents.length} generated files via API.${warningSuffix}`,
      );
    } catch (apiError) {
      const localResult = await compileLocally({
        app: schema,
        includeFileContents: true,
      });
      const diagnosticsText = formatDiagnostics(localResult.diagnostics);

      setCompileSource("local");
      setCompileFiles(localResult.files);

      if (localResult.diagnostics.some((item) => item.severity === "error")) {
        setCompileSummary(
          `Cannot export. Compile API unavailable (${(apiError as Error).message}) and local compile has errors:\n${diagnosticsText}`,
        );
        return;
      }

      if (!localResult.fileContents || localResult.fileContents.length === 0) {
        setCompileSummary("Local compile succeeded but no file contents were available for export.");
        return;
      }

      downloadJsonFile(`${schema.appId}-bundle.json`, {
        appId: schema.appId,
        version: schema.version,
        appDefinition: schema,
        target: "node-fastify-react",
        source: "local",
        generatedAt: localResult.generatedAt,
        docker: localResult.docker,
        diagnostics: localResult.diagnostics,
        files: localResult.fileContents,
      });

      const warningSuffix = diagnosticsText ? `\n${diagnosticsText}` : "";
      setCompileSummary(
        `Exported bundle with ${localResult.fileContents.length} generated files locally (API fallback: ${(apiError as Error).message}).${warningSuffix}`,
      );
    }
  }, [schema]);

  const importBundle = useCallback(
    async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
      const file = event.target.files?.[0];
      if (!file) {
        return;
      }

      try {
        const text = await file.text();
        const payload = JSON.parse(text) as unknown;
        const candidate =
          typeof payload === "object" && payload !== null
            ? ((payload as Record<string, unknown>).appDefinition ??
              (payload as Record<string, unknown>).app ??
              payload)
            : payload;

        const parsed = AppDefinitionSchema.safeParse(candidate);
        if (!parsed.success) {
          const message = parsed.error.issues
            .map((issue) => issue.message)
            .join("; ");
          setCompileSummary(`Import failed: ${message}`);
          return;
        }

        loadFromAppDefinition(parsed.data);
        setCompileSource("none");
        setCompileFiles([]);
        setCompileSummary(
          `Imported app '${parsed.data.appId}' from bundle (${file.name}).`,
        );
      } catch (error) {
        setCompileSummary(`Import failed: ${(error as Error).message}`);
      } finally {
        setFileInputKey((value) => value + 1);
      }
    },
    [loadFromAppDefinition],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "F5") {
        return;
      }
      event.preventDefault();
      void compileNow();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [compileNow]);

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
          <div className="header-actions">
            <button onClick={() => void compileNow()}>Run / Deploy (F5)</button>
            <button onClick={() => void exportBundle()}>Export Bundle</button>
            <label className="import-label">
              Import Bundle
              <input
                key={fileInputKey}
                type="file"
                accept="application/json"
                className="import-input"
                onChange={(event) => void importBundle(event)}
              />
            </label>
          </div>
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
          <p className="meta">Source: {compileSource}</p>
          <pre>{compileSummary || "No compile run yet."}</pre>
          {compileFiles.length > 0 && (
            <ul className="file-list">
              {compileFiles.map((file) => (
                <li key={file.path}>
                  <code>{file.path}</code> ({file.bytes} bytes)
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </DndContext>
  );
}
