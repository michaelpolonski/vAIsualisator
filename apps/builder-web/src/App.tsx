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
import {
  parseBuilderWorkspaceSnapshot,
  useBuilderStore,
  type BuilderWorkspaceSnapshot,
  type BuilderComponentType,
} from "./state/builder-store.js";
import { toAppDefinition } from "./serializer/to-app-definition.js";
import "./styles.css";

interface CompileDiagnostic {
  code: string;
  message: string;
  severity: "error" | "warning";
  path?: string;
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

interface BuilderPreviewResponse {
  statePatch: Record<string, unknown>;
  logs: Array<{ at: string; eventId: string; stage: string; message: string }>;
}

type CompileSource = "none" | "api" | "local";
const AUTOSAVE_STORAGE_KEY = "form-first-builder.autosave.v1";
const SNAPSHOT_HISTORY_STORAGE_KEY = "form-first-builder.snapshots.v1";
const MAX_SNAPSHOT_HISTORY = 20;

interface PersistedAutosaveV1 {
  kind: "form-first-builder-autosave-v1";
  savedAt: string;
  workspace: unknown;
  previewStateDraft?: string;
  previewStateDirty?: boolean;
}

interface SnapshotEntry {
  id: string;
  savedAt: string;
  workspace: BuilderWorkspaceSnapshot;
  previewStateDraft: string;
  previewStateDirty: boolean;
}

interface PersistedSnapshotHistoryV1 {
  kind: "form-first-builder-snapshots-v1";
  entries: SnapshotEntry[];
}

interface SnapshotDiff {
  appMetaChanged: boolean;
  versionChanged: boolean;
  addedComponents: string[];
  removedComponents: string[];
  changedComponents: string[];
  addedConnections: string[];
  removedConnections: string[];
}

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

function buildValidationSummary(diagnostics: CompileDiagnostic[]): string {
  if (diagnostics.length === 0) {
    return "No validation issues.";
  }

  const errorCount = diagnostics.filter((item) => item.severity === "error").length;
  const warningCount = diagnostics.filter((item) => item.severity === "warning").length;
  return `${errorCount} error(s), ${warningCount} warning(s).`;
}

function createFileMetas(files: CompileFileContent[]): CompileFileMeta[] {
  return files.map((file) => ({
    path: file.path,
    bytes: new TextEncoder().encode(file.content).length,
  }));
}

function buildPreviewState(app: AppDefinition): Record<string, unknown> {
  const state: Record<string, unknown> = {};

  for (const [key, field] of Object.entries(app.stateModel)) {
    if (field.type === "string") {
      state[key] = `Preview input for ${key}`;
      continue;
    }
    if (field.type === "number") {
      state[key] = 0;
      continue;
    }
    if (field.type === "boolean") {
      state[key] = false;
      continue;
    }
    if (field.type === "array") {
      state[key] = [];
      continue;
    }
    state[key] = null;
  }

  return state;
}

function parsePreviewStateDraft(input: string): Record<string, unknown> {
  const parsed = JSON.parse(input) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Preview state must be a JSON object.");
  }
  return parsed as Record<string, unknown>;
}

function parseAutosave(value: unknown): PersistedAutosaveV1 | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.kind !== "form-first-builder-autosave-v1") {
    return null;
  }
  if (typeof record.savedAt !== "string") {
    return null;
  }
  if (!("workspace" in record)) {
    return null;
  }
  return {
    kind: "form-first-builder-autosave-v1",
    savedAt: record.savedAt,
    workspace: record.workspace,
    ...(typeof record.previewStateDraft === "string"
      ? { previewStateDraft: record.previewStateDraft }
      : {}),
    ...(typeof record.previewStateDirty === "boolean"
      ? { previewStateDirty: record.previewStateDirty }
      : {}),
  };
}

function parseSnapshotHistory(value: unknown): SnapshotEntry[] | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    record.kind !== "form-first-builder-snapshots-v1" ||
    !Array.isArray(record.entries)
  ) {
    return null;
  }

  const entries: SnapshotEntry[] = [];
  for (const entry of record.entries) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.id !== "string" || typeof candidate.savedAt !== "string") {
      continue;
    }
    const workspace = parseBuilderWorkspaceSnapshot(candidate.workspace);
    if (!workspace) {
      continue;
    }
    entries.push({
      id: candidate.id,
      savedAt: candidate.savedAt,
      workspace,
      previewStateDraft:
        typeof candidate.previewStateDraft === "string"
          ? candidate.previewStateDraft
          : "{}",
      previewStateDirty:
        typeof candidate.previewStateDirty === "boolean"
          ? candidate.previewStateDirty
          : false,
    });
  }

  return entries;
}

function componentSignature(component: BuilderWorkspaceSnapshot["components"][number]): string {
  const base = {
    type: component.type,
    label: component.label,
    position: component.position,
  };

  if (component.type === "TextArea") {
    return JSON.stringify({
      ...base,
      stateKey: component.stateKey ?? "",
    });
  }

  if (component.type === "Button") {
    return JSON.stringify({
      ...base,
      eventId: component.eventId ?? "",
      promptTemplate: component.promptTemplate ?? "",
    });
  }

  return JSON.stringify({
    ...base,
    dataKey: component.dataKey ?? "",
  });
}

function diffSnapshot(args: {
  current: BuilderWorkspaceSnapshot;
  snapshot: BuilderWorkspaceSnapshot;
}): SnapshotDiff {
  const currentComponents = new Map(
    args.current.components.map((component) => [component.id, component]),
  );
  const snapshotComponents = new Map(
    args.snapshot.components.map((component) => [component.id, component]),
  );

  const addedComponents = [...snapshotComponents.keys()].filter(
    (id) => !currentComponents.has(id),
  );
  const removedComponents = [...currentComponents.keys()].filter(
    (id) => !snapshotComponents.has(id),
  );
  const changedComponents = [...currentComponents.keys()].filter((id) => {
    const currentComponent = currentComponents.get(id);
    const snapshotComponent = snapshotComponents.get(id);
    if (!currentComponent || !snapshotComponent) {
      return false;
    }
    return componentSignature(currentComponent) !== componentSignature(snapshotComponent);
  });

  const currentConnections = new Set(
    args.current.connections.map((connection) => `${connection.sourceId} -> ${connection.targetId}`),
  );
  const snapshotConnections = new Set(
    args.snapshot.connections.map(
      (connection) => `${connection.sourceId} -> ${connection.targetId}`,
    ),
  );

  const addedConnections = [...snapshotConnections].filter(
    (key) => !currentConnections.has(key),
  );
  const removedConnections = [...currentConnections].filter(
    (key) => !snapshotConnections.has(key),
  );

  return {
    appMetaChanged: args.current.appId !== args.snapshot.appId,
    versionChanged: args.current.version !== args.snapshot.version,
    addedComponents,
    removedComponents,
    changedComponents,
    addedConnections,
    removedConnections,
  };
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

async function previewViaApi(args: {
  app: AppDefinition;
  eventId: string;
  state: Record<string, unknown>;
}): Promise<BuilderPreviewResponse> {
  const apiBase = import.meta.env.VITE_BUILDER_API_URL ?? "http://localhost:3000";
  const response = await fetch(`${apiBase}/builder/preview/events/${args.eventId}/execute`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      app: args.app,
      state: args.state,
    }),
  });

  const body = (await response.json()) as
    | BuilderPreviewResponse
    | { error?: string; message?: string };

  if (!response.ok) {
    const message =
      "message" in body && body.message
        ? body.message
        : "error" in body && body.error
          ? body.error
          : "Preview API failed";
    throw new Error(message);
  }

  return body as BuilderPreviewResponse;
}

export function App(): JSX.Element {
  const appId = useBuilderStore((state) => state.appId);
  const version = useBuilderStore((state) => state.version);
  const components = useBuilderStore((state) => state.components);
  const connections = useBuilderStore((state) => state.connections);
  const selectedComponentId = useBuilderStore((state) => state.selectedComponentId);
  const addComponent = useBuilderStore((state) => state.addComponent);
  const loadFromAppDefinition = useBuilderStore(
    (state) => state.loadFromAppDefinition,
  );
  const loadWorkspaceSnapshot = useBuilderStore(
    (state) => state.loadWorkspaceSnapshot,
  );

  const [compileSummary, setCompileSummary] = useState<string>("No compile run yet.");
  const [compileFiles, setCompileFiles] = useState<CompileFileMeta[]>([]);
  const [compileSource, setCompileSource] = useState<CompileSource>("none");
  const [validationSummary, setValidationSummary] = useState("Validation pending.");
  const [validationDiagnostics, setValidationDiagnostics] = useState<
    CompileDiagnostic[]
  >([]);
  const [validationCheckedAtMs, setValidationCheckedAtMs] = useState<number | null>(
    null,
  );
  const [previewSummary, setPreviewSummary] = useState("No preview run yet.");
  const [previewOutput, setPreviewOutput] = useState<BuilderPreviewResponse | null>(null);
  const [previewStateDirty, setPreviewStateDirty] = useState(false);
  const [previewStateDraft, setPreviewStateDraft] = useState("{}");
  const [autosaveReady, setAutosaveReady] = useState(false);
  const [autosaveStatus, setAutosaveStatus] = useState("Autosave not initialized.");
  const [snapshotHistory, setSnapshotHistory] = useState<SnapshotEntry[]>([]);
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<string | null>(null);
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

  const defaultPreviewStateText = useMemo(
    () => JSON.stringify(buildPreviewState(schema), null, 2),
    [schema],
  );

  const currentWorkspace = useMemo<BuilderWorkspaceSnapshot>(
    () => ({
      appId,
      version,
      components,
      connections,
    }),
    [appId, version, components, connections],
  );

  useEffect(() => {
    if (!previewStateDirty) {
      setPreviewStateDraft(defaultPreviewStateText);
    }
  }, [defaultPreviewStateText, previewStateDirty]);

  useEffect(() => {
    let canceled = false;
    const timer = window.setTimeout(() => {
      setValidationSummary("Validating...");
      void (async () => {
        try {
          const result = await compileLocally({ app: schema });
          if (canceled) {
            return;
          }
          setValidationDiagnostics(result.diagnostics);
          setValidationSummary(buildValidationSummary(result.diagnostics));
          setValidationCheckedAtMs(Date.now());
        } catch (error) {
          if (canceled) {
            return;
          }
          setValidationDiagnostics([]);
          setValidationSummary(
            `Validation failed: ${(error as Error).message}`,
          );
          setValidationCheckedAtMs(Date.now());
        }
      })();
    }, 250);

    return () => {
      canceled = true;
      window.clearTimeout(timer);
    };
  }, [schema]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(AUTOSAVE_STORAGE_KEY);
      if (!raw) {
        setAutosaveStatus("Autosave active (no prior snapshot).");
        setAutosaveReady(true);
        return;
      }

      const parsed = parseAutosave(JSON.parse(raw));
      if (!parsed) {
        setAutosaveStatus("Autosave data invalid; started fresh.");
        setAutosaveReady(true);
        return;
      }

      const workspace = parseBuilderWorkspaceSnapshot(parsed.workspace);
      if (!workspace) {
        setAutosaveStatus("Autosave workspace invalid; started fresh.");
        setAutosaveReady(true);
        return;
      }

      loadWorkspaceSnapshot(workspace);
      if (parsed.previewStateDraft) {
        setPreviewStateDraft(parsed.previewStateDraft);
        setPreviewStateDirty(parsed.previewStateDirty ?? false);
      }
      setCompileSummary(`Restored autosave from ${parsed.savedAt}.`);
      setAutosaveStatus(`Autosave restored (${parsed.savedAt}).`);
      setAutosaveReady(true);
    } catch {
      setAutosaveStatus("Autosave load failed; started fresh.");
      setAutosaveReady(true);
    }
  }, [loadWorkspaceSnapshot]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(SNAPSHOT_HISTORY_STORAGE_KEY);
      if (!raw) {
        setSelectedSnapshotId(null);
        return;
      }
      const entries = parseSnapshotHistory(JSON.parse(raw));
      if (!entries) {
        setSelectedSnapshotId(null);
        return;
      }
      setSnapshotHistory(entries);
      setSelectedSnapshotId(entries[0]?.id ?? null);
    } catch {
      setSnapshotHistory([]);
      setSelectedSnapshotId(null);
    }
  }, []);

  const selectedPreviewEventId = useMemo(() => {
    const selectedButton = components.find(
      (component) =>
        component.id === selectedComponentId && component.type === "Button",
    );
    return selectedButton?.eventId ?? schema.events[0]?.id ?? undefined;
  }, [components, selectedComponentId, schema.events]);

  const selectedSnapshot = useMemo(
    () => snapshotHistory.find((entry) => entry.id === selectedSnapshotId) ?? null,
    [snapshotHistory, selectedSnapshotId],
  );

  const selectedSnapshotDiff = useMemo(
    () =>
      selectedSnapshot
        ? diffSnapshot({
            current: currentWorkspace,
            snapshot: selectedSnapshot.workspace,
          })
        : null,
    [currentWorkspace, selectedSnapshot],
  );

  useEffect(() => {
    if (!autosaveReady) {
      return;
    }

    const timer = window.setTimeout(() => {
      const payload: PersistedAutosaveV1 = {
        kind: "form-first-builder-autosave-v1",
        savedAt: new Date().toISOString(),
        workspace: currentWorkspace,
        previewStateDraft,
        previewStateDirty,
      };
      localStorage.setItem(AUTOSAVE_STORAGE_KEY, JSON.stringify(payload));
      setAutosaveStatus(`Autosaved at ${payload.savedAt}`);
    }, 200);

    return () => {
      window.clearTimeout(timer);
    };
  }, [
    autosaveReady,
    currentWorkspace,
    previewStateDraft,
    previewStateDirty,
  ]);

  const persistSnapshotHistory = useCallback((entries: SnapshotEntry[]): void => {
    const payload: PersistedSnapshotHistoryV1 = {
      kind: "form-first-builder-snapshots-v1",
      entries,
    };
    localStorage.setItem(SNAPSHOT_HISTORY_STORAGE_KEY, JSON.stringify(payload));
  }, []);

  const saveSnapshot = useCallback((): void => {
    const nextEntry: SnapshotEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      savedAt: new Date().toISOString(),
      workspace: currentWorkspace,
      previewStateDraft,
      previewStateDirty,
    };

    setSnapshotHistory((prev) => {
      const next = [nextEntry, ...prev].slice(0, MAX_SNAPSHOT_HISTORY);
      persistSnapshotHistory(next);
      return next;
    });
    setSelectedSnapshotId(nextEntry.id);
    setAutosaveStatus(`Snapshot saved at ${nextEntry.savedAt}`);
  }, [currentWorkspace, previewStateDraft, previewStateDirty, persistSnapshotHistory]);

  const restoreSnapshot = useCallback(
    (entry: SnapshotEntry): void => {
      loadWorkspaceSnapshot(entry.workspace);
      setPreviewStateDraft(entry.previewStateDraft);
      setPreviewStateDirty(entry.previewStateDirty);
      setPreviewOutput(null);
      setPreviewSummary("No preview run yet.");
      setCompileSummary(`Restored snapshot from ${entry.savedAt}.`);
      setAutosaveStatus(`Snapshot restored (${entry.savedAt}).`);
    },
    [loadWorkspaceSnapshot],
  );

  const deleteSnapshot = useCallback(
    (id: string): void => {
      setSnapshotHistory((prev) => {
        const next = prev.filter((entry) => entry.id !== id);
        persistSnapshotHistory(next);
        if (selectedSnapshotId === id) {
          setSelectedSnapshotId(next[0]?.id ?? null);
        }
        return next;
      });
    },
    [persistSnapshotHistory, selectedSnapshotId],
  );

  const clearSnapshotHistory = useCallback((): void => {
    setSnapshotHistory([]);
    setSelectedSnapshotId(null);
    localStorage.removeItem(SNAPSHOT_HISTORY_STORAGE_KEY);
  }, []);

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
        setPreviewOutput(null);
        setPreviewStateDirty(false);
        setPreviewSummary("No preview run yet.");
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

  const previewRuntime = useCallback(async (): Promise<void> => {
    const selectedEventId = selectedPreviewEventId;

    if (!selectedEventId) {
      setPreviewSummary("No event available to preview.");
      setPreviewOutput(null);
      return;
    }

    setPreviewSummary(`Running preview for event '${selectedEventId}'...`);
    setPreviewOutput(null);

    try {
      const previewState = parsePreviewStateDraft(previewStateDraft);
      const result = await previewViaApi({
        app: schema,
        eventId: selectedEventId,
        state: previewState,
      });

      setPreviewOutput(result);
      setPreviewSummary(
        `Preview executed via API for '${selectedEventId}'. Returned ${Object.keys(result.statePatch).length} state patch key(s) and ${result.logs.length} log entries.`,
      );
    } catch (error) {
      setPreviewSummary(
        `Preview failed: ${(error as Error).message}. Ensure runtime API is running, preview JSON is valid, and model/provider settings are valid.`,
      );
      setPreviewOutput(null);
    }
  }, [selectedPreviewEventId, previewStateDraft, schema]);

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
            <button onClick={() => void previewRuntime()}>Preview Runtime</button>
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
            <button
              onClick={() => {
                localStorage.removeItem(AUTOSAVE_STORAGE_KEY);
                setAutosaveStatus("Autosave cleared.");
              }}
            >
              Clear Autosave
            </button>
            <button onClick={saveSnapshot}>Save Snapshot</button>
            <button onClick={clearSnapshotHistory}>Clear History</button>
          </div>
        </header>
        <p className="meta">{autosaveStatus}</p>

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
          <h2>Live Validation</h2>
          <p className="meta">{validationSummary}</p>
          {validationCheckedAtMs && (
            <p className="meta">
              Last checked: {new Date(validationCheckedAtMs).toLocaleTimeString()}
            </p>
          )}
          {validationDiagnostics.length > 0 && (
            <ul className="validation-list">
              {validationDiagnostics.map((diagnostic, index) => (
                <li
                  key={`${diagnostic.code}-${diagnostic.message}-${index}`}
                  className={`validation-item ${diagnostic.severity}`}
                >
                  <code className="validation-code">
                    {diagnostic.severity.toUpperCase()} {diagnostic.code}
                  </code>
                  <span>{diagnostic.message}</span>
                  {diagnostic.path && (
                    <code className="validation-path">{diagnostic.path}</code>
                  )}
                </li>
              ))}
            </ul>
          )}
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

        <section className="panel">
          <h2>Runtime Preview</h2>
          <p className="meta">
            Event: {selectedPreviewEventId ?? "none"} (select a button to target its event)
          </p>
          <textarea
            className="preview-state-input"
            value={previewStateDraft}
            onChange={(event) => {
              setPreviewStateDraft(event.target.value);
              setPreviewStateDirty(true);
            }}
            placeholder='{"customerComplaint":"The response was slow."}'
          />
          <div className="header-actions">
            <button onClick={() => void previewRuntime()}>Run Preview</button>
            <button
              onClick={() => {
                setPreviewStateDraft(defaultPreviewStateText);
                setPreviewStateDirty(false);
              }}
            >
              Reset Preview State
            </button>
          </div>
          <pre>{previewSummary}</pre>
          {previewOutput && <pre>{JSON.stringify(previewOutput, null, 2)}</pre>}
        </section>

        <section className="panel">
          <h2>Snapshot History</h2>
          {snapshotHistory.length === 0 ? (
            <p className="meta">No saved snapshots yet.</p>
          ) : (
            <ul className="snapshot-list">
              {snapshotHistory.map((entry) => (
                <li
                  key={entry.id}
                  className={`snapshot-item ${
                    selectedSnapshotId === entry.id ? "active" : ""
                  }`}
                >
                  <div className="snapshot-meta">
                    <code>{entry.savedAt}</code>
                  </div>
                  <div className="snapshot-actions">
                    <button onClick={() => setSelectedSnapshotId(entry.id)}>View Diff</button>
                    <button onClick={() => restoreSnapshot(entry)}>Restore</button>
                    <button onClick={() => deleteSnapshot(entry.id)}>Delete</button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="panel">
          <h2>Snapshot Diff</h2>
          {!selectedSnapshot || !selectedSnapshotDiff ? (
            <p className="meta">Select a snapshot to view diff.</p>
          ) : (
            <div className="diff-grid">
              <div className="diff-card">
                <div className="diff-title">Metadata</div>
                <div className="meta">
                  appId changed: {selectedSnapshotDiff.appMetaChanged ? "yes" : "no"}
                </div>
                <div className="meta">
                  version changed: {selectedSnapshotDiff.versionChanged ? "yes" : "no"}
                </div>
              </div>
              <div className="diff-card">
                <div className="diff-title">Components</div>
                <div className="meta">
                  added: {selectedSnapshotDiff.addedComponents.length}
                </div>
                <div className="meta">
                  removed: {selectedSnapshotDiff.removedComponents.length}
                </div>
                <div className="meta">
                  changed: {selectedSnapshotDiff.changedComponents.length}
                </div>
              </div>
              <div className="diff-card">
                <div className="diff-title">Connections</div>
                <div className="meta">
                  added: {selectedSnapshotDiff.addedConnections.length}
                </div>
                <div className="meta">
                  removed: {selectedSnapshotDiff.removedConnections.length}
                </div>
              </div>

              <div className="diff-card">
                <div className="diff-title">Added Components</div>
                <pre>{selectedSnapshotDiff.addedComponents.join("\n") || "(none)"}</pre>
              </div>
              <div className="diff-card">
                <div className="diff-title">Removed Components</div>
                <pre>{selectedSnapshotDiff.removedComponents.join("\n") || "(none)"}</pre>
              </div>
              <div className="diff-card">
                <div className="diff-title">Changed Components</div>
                <pre>{selectedSnapshotDiff.changedComponents.join("\n") || "(none)"}</pre>
              </div>
              <div className="diff-card">
                <div className="diff-title">Added Connections</div>
                <pre>{selectedSnapshotDiff.addedConnections.join("\n") || "(none)"}</pre>
              </div>
              <div className="diff-card">
                <div className="diff-title">Removed Connections</div>
                <pre>{selectedSnapshotDiff.removedConnections.join("\n") || "(none)"}</pre>
              </div>
            </div>
          )}
        </section>
      </main>
    </DndContext>
  );
}
