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
  getPromptVariables,
  getPromptDiagnosticsForButton,
  parseBuilderWorkspaceSnapshot,
  useBuilderStore,
  type BuilderWorkspaceSnapshot,
  type BuilderConnection,
  type BuilderComponent,
  type BuilderComponentType,
} from "./state/builder-store.js";
import { toAppDefinition } from "./serializer/to-app-definition.js";
import {
  DEFAULT_MODEL_POLICY,
  getDefaultModelForProvider,
  type SupportedModelProvider,
} from "./prompt-schema/model-policy.js";
import { DEFAULT_OUTPUT_SCHEMA_JSON } from "./prompt-schema/output-schema.js";
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

interface ProviderStatusItem {
  available: boolean;
  reason: string | null;
}

interface BuilderProviderStatusResponse {
  providers: Partial<Record<SupportedModelProvider, ProviderStatusItem>>;
  checkedAt: string;
}

interface ModelCatalogProviderEntry {
  defaultModel: string;
  models: string[];
}

interface BuilderModelCatalogResponse {
  providers: Partial<Record<SupportedModelProvider, ModelCatalogProviderEntry>>;
  fetchedAt: string;
  source?: Partial<Record<SupportedModelProvider, string>>;
}

interface DiagnosticFixAction {
  label: string;
  apply: () => void;
}

interface DiagnosticFixCandidate {
  key: string;
  fix: DiagnosticFixAction;
}

interface LastFixUndoState {
  label: string;
  workspace: BuilderWorkspaceSnapshot;
  previewStateDraft: string;
  previewStateDirty: boolean;
}

function extractBracedVariableToken(message: string): string | null {
  const match = message.match(/{{\s*([^}]+?)\s*}}/);
  const token = match?.[1]?.trim();
  return token && token.length > 0 ? token : null;
}

function buildDiagnosticFixKey(args: {
  diagnostic: CompileDiagnostic;
  fixLabel: string;
}): string {
  return `${buildDiagnosticRuleKey(args.diagnostic)}::${args.fixLabel}`;
}

function buildDiagnosticRuleKey(diagnostic: CompileDiagnostic): string {
  return [diagnostic.code, diagnostic.path ?? "", diagnostic.message].join("::");
}

function buildBuilderGuardrailDiagnostics(args: {
  components: BuilderComponent[];
  connections: BuilderConnection[];
  providerStatus: Partial<Record<SupportedModelProvider, ProviderStatusItem>> | null;
}): CompileDiagnostic[] {
  const diagnostics: CompileDiagnostic[] = [];

  for (const component of args.components) {
    if (component.type !== "Button") {
      continue;
    }

    const promptDiagnostics = getPromptDiagnosticsForButton({
      components: args.components,
      connections: args.connections,
      buttonId: component.id,
    });

    if (promptDiagnostics.invalidOutputSchema) {
      diagnostics.push({
        code: "BUILDER_INVALID_OUTPUT_SCHEMA",
        severity: "warning",
        path: `ui.components.${component.id}.outputSchemaJson`,
        message: promptDiagnostics.invalidOutputSchema,
      });
    }

    for (const issue of promptDiagnostics.invalidModelPolicy) {
      diagnostics.push({
        code: "BUILDER_INVALID_MODEL_POLICY",
        severity: "warning",
        path: `ui.components.${component.id}.modelPolicy`,
        message: issue,
      });
    }

    for (const variable of promptDiagnostics.disconnectedVariables) {
      diagnostics.push({
        code: "BUILDER_DISCONNECTED_VARIABLE",
        severity: "warning",
        path: `ui.components.${component.id}.promptTemplate`,
        message: `Variable '{{${variable}}}' is not connected to this button event input path.`,
      });
    }

    const provider = component.modelProvider ?? "mock";
    const providerStatus = args.providerStatus?.[provider];
    if (providerStatus && !providerStatus.available) {
      diagnostics.push({
        code: "BUILDER_PROVIDER_UNAVAILABLE",
        severity: "warning",
        path: `ui.components.${component.id}.modelProvider`,
        message: `Provider '${provider}' is unavailable: ${providerStatus.reason ?? "missing credentials."}`,
      });
    }
  }

  return diagnostics;
}

type CompileSource = "none" | "api" | "local";
const AUTOSAVE_STORAGE_KEY = "form-first-builder.autosave.v1";
const SNAPSHOT_HISTORY_STORAGE_KEY = "form-first-builder.snapshots.v1";
const MUTED_VALIDATION_RULES_STORAGE_KEY = "form-first-builder.validation-muted.v1";
const MUTED_VALIDATION_CODES_STORAGE_KEY = "form-first-builder.validation-muted-codes.v1";
const VALIDATION_PREFS_STORAGE_KEY = "form-first-builder.validation-prefs.v1";
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

interface PersistedValidationPrefsV1 {
  kind: "form-first-builder-validation-prefs-v1";
  showErrors: boolean;
  showWarnings: boolean;
  showMuted: boolean;
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

interface DiagnosticTarget {
  componentId: string;
  openPromptEditor: boolean;
  eventId?: string;
  actionNodeId?: string;
}

interface ParsedDiagnosticRule {
  code: string;
  path: string;
  message: string;
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

function isEditableKeyboardTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  const tag = target.tagName.toLowerCase();
  return (
    tag === "input" ||
    tag === "textarea" ||
    tag === "select" ||
    target.isContentEditable
  );
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

function isPromptDiagnostic(path?: string): boolean {
  if (!path) {
    return false;
  }
  return path.includes(".promptSpec.");
}

function extractActionNodeIdFromPath(segments: string[]): string | undefined {
  const actionGraphIndex = segments.findIndex((segment) => segment === "actionGraph");
  if (actionGraphIndex < 0) {
    return undefined;
  }

  if (segments[actionGraphIndex + 1] !== "nodes") {
    return undefined;
  }

  return segments[actionGraphIndex + 2];
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

function parseMutedValidationRules(value: unknown): string[] | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (record.kind !== "form-first-builder-validation-muted-v1") {
    return null;
  }
  if (!Array.isArray(record.rules)) {
    return null;
  }

  return record.rules
    .filter((item): item is string => typeof item === "string")
    .filter((item) => item.length > 0);
}

function parseMutedValidationCodes(value: unknown): string[] | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (record.kind !== "form-first-builder-validation-muted-codes-v1") {
    return null;
  }
  if (!Array.isArray(record.codes)) {
    return null;
  }

  return record.codes
    .filter((item): item is string => typeof item === "string")
    .filter((item) => item.length > 0);
}

function parseValidationPrefs(value: unknown): PersistedValidationPrefsV1 | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (record.kind !== "form-first-builder-validation-prefs-v1") {
    return null;
  }
  if (
    typeof record.showErrors !== "boolean" ||
    typeof record.showWarnings !== "boolean" ||
    typeof record.showMuted !== "boolean"
  ) {
    return null;
  }

  return {
    kind: "form-first-builder-validation-prefs-v1",
    showErrors: record.showErrors,
    showWarnings: record.showWarnings,
    showMuted: record.showMuted,
  };
}

function parseDiagnosticRuleKey(rule: string): ParsedDiagnosticRule {
  const firstDivider = rule.indexOf("::");
  const secondDivider = firstDivider >= 0 ? rule.indexOf("::", firstDivider + 2) : -1;
  if (firstDivider < 0 || secondDivider < 0) {
    return { code: rule, path: "", message: "" };
  }

  return {
    code: rule.slice(0, firstDivider),
    path: rule.slice(firstDivider + 2, secondDivider),
    message: rule.slice(secondDivider + 2),
  };
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
      outputSchemaJson: component.outputSchemaJson ?? "",
      modelProvider: component.modelProvider ?? "",
      modelName: component.modelName ?? "",
      modelTemperature: component.modelTemperature ?? "",
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
  mode?: "overlay" | "bundle";
}): Promise<BuilderCompileResponse> {
  const apiBase = import.meta.env.VITE_BUILDER_API_URL ?? "http://localhost:3000";
  const response = await fetch(`${apiBase}/builder/compile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      app: args.app,
      target: "node-fastify-react",
      mode: args.mode ?? "overlay",
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

async function fetchDeployableTgzViaApi(args: {
  app: AppDefinition;
}): Promise<Blob> {
  const apiBase = import.meta.env.VITE_BUILDER_API_URL ?? "http://localhost:3000";
  const response = await fetch(`${apiBase}/builder/bundle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      app: args.app,
      target: "node-fastify-react",
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || "Bundle export failed");
  }

  return response.blob();
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

async function fetchProviderStatusViaApi(): Promise<BuilderProviderStatusResponse> {
  const apiBase = import.meta.env.VITE_BUILDER_API_URL ?? "http://localhost:3000";
  const response = await fetch(`${apiBase}/builder/providers/status`);
  const body = (await response.json()) as
    | BuilderProviderStatusResponse
    | { error?: string; message?: string };

  if (!response.ok) {
    const message =
      "message" in body && body.message
        ? body.message
        : "error" in body && body.error
          ? body.error
          : "Provider status API failed";
    throw new Error(message);
  }

  return body as BuilderProviderStatusResponse;
}

async function fetchModelCatalogViaApi(): Promise<BuilderModelCatalogResponse> {
  const apiBase = import.meta.env.VITE_BUILDER_API_URL ?? "http://localhost:3000";
  const response = await fetch(`${apiBase}/builder/models/catalog`);

  const body = (await response.json()) as
    | BuilderModelCatalogResponse
    | { error?: string; message?: string };

  if (!response.ok) {
    const message =
      "message" in body && body.message
        ? body.message
        : "error" in body && body.error
          ? body.error
          : "Model catalog API failed";
    throw new Error(message);
  }

  return body as BuilderModelCatalogResponse;
}

function getBuilderAuthHeaders(): Record<string, string> {
  const apiKey = import.meta.env.VITE_BUILDER_API_KEY as string | undefined;
  if (!apiKey || apiKey.trim().length === 0) {
    return {};
  }
  return { Authorization: `Bearer ${apiKey.trim()}` };
}

async function listProjectsViaApi(): Promise<{
  projects: Array<{
    id: string;
    name: string;
    createdAt: string;
    updatedAt: string;
    latestVersionId: string;
  }>;
}> {
  const apiBase = import.meta.env.VITE_BUILDER_API_URL ?? "http://localhost:3000";
  const response = await fetch(`${apiBase}/builder/projects`, {
    headers: { ...getBuilderAuthHeaders() },
  });
  const body = (await response.json()) as
    | { projects: Array<{ id: string; name: string; createdAt: string; updatedAt: string; latestVersionId: string }> }
    | { error?: string; message?: string };
  if (!response.ok) {
    const message =
      "message" in body && body.message
        ? body.message
        : "error" in body && body.error
          ? body.error
          : "Project list API failed";
    throw new Error(message);
  }
  return body as { projects: Array<{ id: string; name: string; createdAt: string; updatedAt: string; latestVersionId: string }> };
}

async function upsertProjectViaApi(args: {
  projectId: string;
  name?: string;
  note?: string;
  appDefinition: AppDefinition;
  workspaceSnapshot: BuilderWorkspaceSnapshot;
  previewStateDraft: string;
  previewStateDirty: boolean;
}): Promise<{ project: { id: string; latestVersionId: string }; saved: { id: string } }> {
  const apiBase = import.meta.env.VITE_BUILDER_API_URL ?? "http://localhost:3000";
  const response = await fetch(`${apiBase}/builder/projects/${args.projectId}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...getBuilderAuthHeaders() },
    body: JSON.stringify({
      name: args.name,
      note: args.note,
      appDefinition: args.appDefinition,
      workspaceSnapshot: args.workspaceSnapshot,
      previewStateDraft: args.previewStateDraft,
      previewStateDirty: args.previewStateDirty,
    }),
  });
  const body = (await response.json()) as
    | { project: { id: string; latestVersionId: string }; saved: { id: string } }
    | { error?: string; message?: string };
  if (!response.ok) {
    const message =
      "message" in body && body.message
        ? body.message
        : "error" in body && body.error
          ? body.error
          : "Project save API failed";
    throw new Error(message);
  }
  return body as { project: { id: string; latestVersionId: string }; saved: { id: string } };
}

async function fetchProjectViaApi(projectId: string): Promise<{
  project: { id: string; latestVersionId: string; name: string };
  latest: {
    appDefinition: AppDefinition;
    workspaceSnapshot?: unknown;
    previewStateDraft?: string;
    previewStateDirty?: boolean;
  };
}> {
  const apiBase = import.meta.env.VITE_BUILDER_API_URL ?? "http://localhost:3000";
  const response = await fetch(`${apiBase}/builder/projects/${projectId}`, {
    headers: { ...getBuilderAuthHeaders() },
  });
  const body = (await response.json()) as
    | {
        project: { id: string; latestVersionId: string; name: string };
        latest: {
          appDefinition: AppDefinition;
          workspaceSnapshot?: unknown;
          previewStateDraft?: string;
          previewStateDirty?: boolean;
        };
      }
    | { error?: string; message?: string };
  if (!response.ok) {
    const message =
      "message" in body && body.message
        ? body.message
        : "error" in body && body.error
          ? body.error
          : "Project load API failed";
    throw new Error(message);
  }
  return body as {
    project: { id: string; latestVersionId: string; name: string };
    latest: {
      appDefinition: AppDefinition;
      workspaceSnapshot?: unknown;
      previewStateDraft?: string;
      previewStateDirty?: boolean;
    };
  };
}

export function App(): JSX.Element {
  const appId = useBuilderStore((state) => state.appId);
  const version = useBuilderStore((state) => state.version);
  const components = useBuilderStore((state) => state.components);
  const connections = useBuilderStore((state) => state.connections);
  const selectedComponentId = useBuilderStore((state) => state.selectedComponentId);
  const addComponent = useBuilderStore((state) => state.addComponent);
  const addConnection = useBuilderStore((state) => state.addConnection);
  const updateComponent = useBuilderStore((state) => state.updateComponent);
  const selectComponent = useBuilderStore((state) => state.selectComponent);
  const focusPromptEditor = useBuilderStore((state) => state.focusPromptEditor);
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
  const [allValidationDiagnostics, setAllValidationDiagnostics] = useState<
    CompileDiagnostic[]
  >([]);
  const [validationDiagnostics, setValidationDiagnostics] = useState<
    CompileDiagnostic[]
  >([]);
  const [mutedValidationRules, setMutedValidationRules] = useState<string[]>([]);
  const [mutedValidationCodes, setMutedValidationCodes] = useState<string[]>([]);
  const [showValidationErrors, setShowValidationErrors] = useState(true);
  const [showValidationWarnings, setShowValidationWarnings] = useState(true);
  const [showMutedDiagnostics, setShowMutedDiagnostics] = useState(false);
  const [lastFixUndoState, setLastFixUndoState] = useState<LastFixUndoState | null>(
    null,
  );
  const [validationFixStatus, setValidationFixStatus] = useState<string | null>(null);
  const [validationCheckedAtMs, setValidationCheckedAtMs] = useState<number | null>(
    null,
  );
  const [previewSummary, setPreviewSummary] = useState("No preview run yet.");
  const [previewOutput, setPreviewOutput] = useState<BuilderPreviewResponse | null>(null);
  const [previewStateDirty, setPreviewStateDirty] = useState(false);
  const [previewStateDraft, setPreviewStateDraft] = useState("{}");
  const [allowPreviewProviderOverride, setAllowPreviewProviderOverride] =
    useState(false);
  const [autosaveReady, setAutosaveReady] = useState(false);
  const [autosaveStatus, setAutosaveStatus] = useState("Autosave not initialized.");
  const [providerStatusSummary, setProviderStatusSummary] = useState(
    "Provider status unavailable.",
  );
  const [providerStatus, setProviderStatus] = useState<
    Partial<Record<SupportedModelProvider, ProviderStatusItem>> | null
  >(null);
  const [modelCatalogSummary, setModelCatalogSummary] = useState(
    "Model catalog unavailable.",
  );
  const [modelCatalog, setModelCatalog] = useState<
    Partial<Record<SupportedModelProvider, ModelCatalogProviderEntry>> | null
  >(null);
  const [snapshotHistory, setSnapshotHistory] = useState<SnapshotEntry[]>([]);
  const [selectedSnapshotId, setSelectedSnapshotId] = useState<string | null>(null);
  const [focusedGraphNode, setFocusedGraphNode] = useState<{
    eventId: string;
    nodeId: string;
  } | null>(null);
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

  const mutedRuleSet = useMemo(
    () => new Set(mutedValidationRules),
    [mutedValidationRules],
  );

  const mutedCodeSet = useMemo(
    () => new Set(mutedValidationCodes),
    [mutedValidationCodes],
  );

  const mutedDiagnosticsFromAll = useMemo(
    () =>
      allValidationDiagnostics.filter((item) =>
        mutedRuleSet.has(buildDiagnosticRuleKey(item)) || mutedCodeSet.has(item.code),
      ),
    [allValidationDiagnostics, mutedCodeSet, mutedRuleSet],
  );

  const mutedCodeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const item of allValidationDiagnostics) {
      if (!mutedCodeSet.has(item.code)) {
        continue;
      }
      counts[item.code] = (counts[item.code] ?? 0) + 1;
    }
    return counts;
  }, [allValidationDiagnostics, mutedCodeSet]);

  useEffect(() => {
    if (!previewStateDirty) {
      setPreviewStateDraft(defaultPreviewStateText);
    }
  }, [defaultPreviewStateText, previewStateDirty]);

  useEffect(() => {
    if (!focusedGraphNode) {
      return;
    }

    const event = schema.events.find((item) => item.id === focusedGraphNode.eventId);
    if (!event) {
      setFocusedGraphNode(null);
      return;
    }

    const nodeExists = event.actionGraph.nodes.some(
      (node) => node.id === focusedGraphNode.nodeId,
    );
    if (!nodeExists) {
      setFocusedGraphNode(null);
    }
  }, [focusedGraphNode, schema.events]);

  useEffect(() => {
    let canceled = false;
    const timer = window.setTimeout(() => {
      setValidationSummary("Validating...");
      void (async () => {
        try {
          const result = await compileLocally({ app: schema });
          const guardrailDiagnostics = buildBuilderGuardrailDiagnostics({
            components,
            connections,
            providerStatus,
          });
          const mergedDiagnostics = [...result.diagnostics, ...guardrailDiagnostics];
          const isMuted = (item: CompileDiagnostic): boolean =>
            mutedRuleSet.has(buildDiagnosticRuleKey(item)) || mutedCodeSet.has(item.code);
          const isSeverityHidden = (item: CompileDiagnostic): boolean => {
            if (item.severity === "error" && !showValidationErrors) {
              return true;
            }
            if (item.severity === "warning" && !showValidationWarnings) {
              return true;
            }
            return false;
          };
          const hideMuted = !showMutedDiagnostics;

          const visibleDiagnostics = mergedDiagnostics.filter((item) => {
            if (isSeverityHidden(item)) {
              return false;
            }
            if (hideMuted && isMuted(item)) {
              return false;
            }
            return true;
          });

          const hiddenBySeverity = mergedDiagnostics.filter(isSeverityHidden).length;
          const hiddenByMute =
            hideMuted
              ? mergedDiagnostics.filter((item) => isMuted(item) && !isSeverityHidden(item))
                  .length
              : 0;
          const baseSummary = buildValidationSummary(visibleDiagnostics);
          const hiddenParts: string[] = [];
          if (!showMutedDiagnostics && hiddenByMute > 0) {
            hiddenParts.push(`muted ${hiddenByMute}`);
          }
          if (hiddenBySeverity > 0) {
            hiddenParts.push(`filtered ${hiddenBySeverity}`);
          }
          if (canceled) {
            return;
          }
          setAllValidationDiagnostics(mergedDiagnostics);
          setValidationDiagnostics(visibleDiagnostics);
          setValidationSummary(
            hiddenParts.length > 0
              ? `${baseSummary} (hidden: ${hiddenParts.join(", ")})`
              : baseSummary,
          );
          setValidationCheckedAtMs(Date.now());
        } catch (error) {
          if (canceled) {
            return;
          }
          setAllValidationDiagnostics([]);
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
  }, [
    components,
    connections,
    mutedRuleSet,
    mutedCodeSet,
    providerStatus,
    schema,
    showMutedDiagnostics,
    showValidationErrors,
    showValidationWarnings,
  ]);

  useEffect(() => {
    let canceled = false;
    void (async () => {
      try {
        const status = await fetchProviderStatusViaApi();
        if (canceled) {
          return;
        }
        setProviderStatus(status.providers);
        const providerNames = (Object.keys(status.providers) as SupportedModelProvider[])
          .filter((provider) => status.providers[provider]?.available)
          .join(", ");
        setProviderStatusSummary(
          providerNames.length > 0
            ? `Providers ready: ${providerNames}`
            : "No external providers configured. Mock is available.",
        );
      } catch (error) {
        if (canceled) {
          return;
        }
        setProviderStatus(null);
        setProviderStatusSummary(
          `Provider status unavailable: ${(error as Error).message}`,
        );
      }
    })();

    return () => {
      canceled = true;
    };
  }, []);

  useEffect(() => {
    let canceled = false;
    void (async () => {
      try {
        const catalog = await fetchModelCatalogViaApi();
        if (canceled) {
          return;
        }
        setModelCatalog(catalog.providers);
        const openaiCount = catalog.providers.openai?.models?.length ?? 0;
        const anthropicCount = catalog.providers.anthropic?.models?.length ?? 0;
        setModelCatalogSummary(
          `Model catalog ready: openai ${openaiCount}, anthropic ${anthropicCount}.`,
        );
      } catch (error) {
        if (canceled) {
          return;
        }
        setModelCatalog(null);
        setModelCatalogSummary(`Model catalog unavailable: ${(error as Error).message}`);
      }
    })();

    return () => {
      canceled = true;
    };
  }, []);
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

  useEffect(() => {
    try {
      const raw = localStorage.getItem(MUTED_VALIDATION_RULES_STORAGE_KEY);
      if (!raw) {
        return;
      }
      const parsed = parseMutedValidationRules(JSON.parse(raw));
      if (!parsed) {
        return;
      }
      setMutedValidationRules(parsed);
    } catch {
      setMutedValidationRules([]);
    }
  }, []);

  useEffect(() => {
    const payload = {
      kind: "form-first-builder-validation-muted-v1",
      rules: mutedValidationRules,
    };
    localStorage.setItem(MUTED_VALIDATION_RULES_STORAGE_KEY, JSON.stringify(payload));
  }, [mutedValidationRules]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(MUTED_VALIDATION_CODES_STORAGE_KEY);
      if (!raw) {
        return;
      }
      const parsed = parseMutedValidationCodes(JSON.parse(raw));
      if (!parsed) {
        return;
      }
      setMutedValidationCodes(parsed);
    } catch {
      setMutedValidationCodes([]);
    }
  }, []);

  useEffect(() => {
    const payload = {
      kind: "form-first-builder-validation-muted-codes-v1",
      codes: mutedValidationCodes,
    };
    localStorage.setItem(MUTED_VALIDATION_CODES_STORAGE_KEY, JSON.stringify(payload));
  }, [mutedValidationCodes]);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(VALIDATION_PREFS_STORAGE_KEY);
      if (!raw) {
        return;
      }
      const parsed = parseValidationPrefs(JSON.parse(raw));
      if (!parsed) {
        return;
      }
      setShowValidationErrors(parsed.showErrors);
      setShowValidationWarnings(parsed.showWarnings);
      setShowMutedDiagnostics(parsed.showMuted);
    } catch {
      setShowValidationErrors(true);
      setShowValidationWarnings(true);
      setShowMutedDiagnostics(false);
    }
  }, []);

  useEffect(() => {
    const payload: PersistedValidationPrefsV1 = {
      kind: "form-first-builder-validation-prefs-v1",
      showErrors: showValidationErrors,
      showWarnings: showValidationWarnings,
      showMuted: showMutedDiagnostics,
    };
    localStorage.setItem(VALIDATION_PREFS_STORAGE_KEY, JSON.stringify(payload));
  }, [showMutedDiagnostics, showValidationErrors, showValidationWarnings]);

  const selectedPreviewEventId = useMemo(() => {
    const selectedButton = components.find(
      (component) =>
        component.id === selectedComponentId && component.type === "Button",
    );
    return selectedButton?.eventId ?? schema.events[0]?.id ?? undefined;
  }, [components, selectedComponentId, schema.events]);

  const selectedPreviewEvent = useMemo(
    () =>
      selectedPreviewEventId
        ? schema.events.find((event) => event.id === selectedPreviewEventId) ?? null
        : null,
    [schema.events, selectedPreviewEventId],
  );

  const selectedPreviewProvider = useMemo<SupportedModelProvider | null>(() => {
    if (!selectedPreviewEvent) {
      return null;
    }
    const promptNode = selectedPreviewEvent.actionGraph.nodes.find(
      (node) => node.kind === "PromptTask",
    );
    if (!promptNode || promptNode.kind !== "PromptTask") {
      return null;
    }
    return promptNode.promptSpec.modelPolicy.provider;
  }, [selectedPreviewEvent]);

  const selectedPreviewProviderStatus = useMemo(
    () =>
      selectedPreviewProvider && providerStatus
        ? providerStatus[selectedPreviewProvider] ?? null
        : null,
    [providerStatus, selectedPreviewProvider],
  );

  const isPreviewBlockedByProvider = useMemo(
    () =>
      !allowPreviewProviderOverride &&
      !!selectedPreviewProviderStatus &&
      !selectedPreviewProviderStatus.available,
    [allowPreviewProviderOverride, selectedPreviewProviderStatus],
  );

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

  const componentById = useMemo(
    () => new Map(components.map((component) => [component.id, component])),
    [components],
  );

  const eventToComponentId = useMemo(
    () =>
      new Map(
        schema.events.map((event) => [event.id, event.trigger.componentId] as const),
      ),
    [schema.events],
  );

  const resolveDiagnosticTarget = useCallback(
    (diagnostic: CompileDiagnostic): DiagnosticTarget | null => {
      const path = diagnostic.path;
      if (!path) {
        return null;
      }

      const segments = path.split(".");
      if (segments.length < 3) {
        return null;
      }

      if (segments[0] === "ui" && segments[1] === "components") {
        const componentId = segments[2];
        if (!componentId) {
          return null;
        }
        const component = componentById.get(componentId);
        if (!component) {
          return null;
        }
        return { componentId, openPromptEditor: false };
      }

      if (segments[0] === "events" && segments[1]) {
        const eventId = segments[1];
        if (!eventId) {
          return null;
        }
        const componentId = eventToComponentId.get(eventId);
        if (!componentId) {
          return null;
        }
        const component = componentById.get(componentId);
        if (!component) {
          return null;
        }
        const actionNodeId = extractActionNodeIdFromPath(segments);
        return {
          componentId,
          openPromptEditor: component.type === "Button" && isPromptDiagnostic(path),
          eventId,
          ...(actionNodeId ? { actionNodeId } : {}),
        };
      }

      return null;
    },
    [componentById, eventToComponentId],
  );

  const resolveDiagnosticFix = useCallback(
    (
      diagnostic: CompileDiagnostic,
      target: DiagnosticTarget | null,
    ): DiagnosticFixAction | null => {
      if (!target) {
        return null;
      }

      const component = componentById.get(target.componentId);
      if (!component || component.type !== "Button") {
        return null;
      }

      if (diagnostic.code === "BUILDER_PROVIDER_UNAVAILABLE") {
        return {
          label: "Switch to mock",
          apply: () => {
            updateComponent(component.id, {
              modelProvider: "mock",
              modelName: getDefaultModelForProvider("mock"),
            });
          },
        };
      }

      if (diagnostic.code === "BUILDER_INVALID_OUTPUT_SCHEMA") {
        return {
          label: "Reset Output Schema",
          apply: () => {
            updateComponent(component.id, {
              outputSchemaJson: DEFAULT_OUTPUT_SCHEMA_JSON,
            });
          },
        };
      }

      if (diagnostic.code === "BUILDER_INVALID_MODEL_POLICY") {
        const provider = component.modelProvider ?? DEFAULT_MODEL_POLICY.provider;
        const message = diagnostic.message.toLowerCase();
        if (message.includes("temperature")) {
          return {
            label: "Reset Temperature",
            apply: () => {
              updateComponent(component.id, {
                modelTemperature: String(DEFAULT_MODEL_POLICY.temperature),
              });
            },
          };
        }
        if (message.includes("model name")) {
          return {
            label: "Set Default Model",
            apply: () => {
              updateComponent(component.id, {
                modelName: getDefaultModelForProvider(provider),
              });
            },
          };
        }

        return {
          label: "Apply Model Defaults",
          apply: () => {
            updateComponent(component.id, {
              modelName: getDefaultModelForProvider(provider),
              modelTemperature: String(DEFAULT_MODEL_POLICY.temperature),
            });
          },
        };
      }

      if (diagnostic.code === "BUILDER_DISCONNECTED_VARIABLE") {
        const variable = extractBracedVariableToken(diagnostic.message);
        if (!variable) {
          return null;
        }
        const source = components.find(
          (item) => item.type === "TextArea" && item.stateKey === variable,
        );
        if (!source) {
          return null;
        }
        return {
          label: `Connect {{${variable}}}`,
          apply: () => {
            addConnection(source.id, component.id);
          },
        };
      }

      if (diagnostic.code === "UNKNOWN_PROMPT_VARIABLE") {
        const availableVariables = getPromptVariables(component.id);
        const fallback = availableVariables[0];
        if (!fallback) {
          return null;
        }
        const token = `{{${fallback}}}`;
        const existingTemplate = component.promptTemplate ?? "";
        if (existingTemplate.includes(token)) {
          return null;
        }
        return {
          label: `Insert ${token}`,
          apply: () => {
            updateComponent(component.id, {
              promptTemplate: `${existingTemplate} ${token}`.trim(),
            });
          },
        };
      }

      return null;
    },
    [addConnection, componentById, components, updateComponent],
  );

  const availableValidationFixes = useMemo<DiagnosticFixCandidate[]>(() => {
    const seen = new Set<string>();
    const fixes: DiagnosticFixCandidate[] = [];

    for (const diagnostic of validationDiagnostics) {
      const target = resolveDiagnosticTarget(diagnostic);
      const fix = resolveDiagnosticFix(diagnostic, target);
      if (!fix) {
        continue;
      }

      const key = buildDiagnosticFixKey({
        diagnostic,
        fixLabel: fix.label,
      });
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      fixes.push({ key, fix });
    }

    return fixes;
  }, [resolveDiagnosticFix, resolveDiagnosticTarget, validationDiagnostics]);

  const applyFixWithUndo = useCallback(
    (fix: DiagnosticFixAction): void => {
      setLastFixUndoState({
        label: fix.label,
        workspace: currentWorkspace,
        previewStateDraft,
        previewStateDirty,
      });
      fix.apply();
      setValidationFixStatus(`Applied fix: ${fix.label}`);
    },
    [currentWorkspace, previewStateDraft, previewStateDirty],
  );

  const applyAllValidationFixes = useCallback((): void => {
    if (availableValidationFixes.length === 0) {
      setValidationFixStatus("No automatic fixes available.");
      return;
    }

    setLastFixUndoState({
      label: `Apply all fixes (${availableValidationFixes.length})`,
      workspace: currentWorkspace,
      previewStateDraft,
      previewStateDirty,
    });

    for (const item of availableValidationFixes) {
      item.fix.apply();
    }

    setValidationFixStatus(
      `Applied ${availableValidationFixes.length} fix(es).`,
    );
  }, [
    availableValidationFixes,
    currentWorkspace,
    previewStateDraft,
    previewStateDirty,
  ]);

  const undoLastFix = useCallback((): void => {
    if (!lastFixUndoState) {
      return;
    }

    loadWorkspaceSnapshot(lastFixUndoState.workspace);
    setPreviewStateDraft(lastFixUndoState.previewStateDraft);
    setPreviewStateDirty(lastFixUndoState.previewStateDirty);
    setValidationFixStatus(`Undid fix: ${lastFixUndoState.label}`);
    setLastFixUndoState(null);
  }, [lastFixUndoState, loadWorkspaceSnapshot]);

  const ignoreDiagnosticRule = useCallback((diagnostic: CompileDiagnostic): void => {
    const rule = buildDiagnosticRuleKey(diagnostic);
    setMutedValidationRules((prev) => {
      if (prev.includes(rule)) {
        return prev;
      }
      return [...prev, rule];
    });
    setValidationFixStatus(`Ignored diagnostic rule: ${diagnostic.code}`);
  }, []);

  const ignoreDiagnosticCode = useCallback((diagnostic: CompileDiagnostic): void => {
    const code = diagnostic.code;
    setMutedValidationCodes((prev) => {
      if (prev.includes(code)) {
        return prev;
      }
      return [...prev, code];
    });
    setValidationFixStatus(`Ignored diagnostic code: ${diagnostic.code}`);
  }, []);

  const clearMutedValidationRules = useCallback((): void => {
    setMutedValidationRules([]);
    setValidationFixStatus("Cleared muted validation rules.");
  }, []);

  const clearMutedValidationCodes = useCallback((): void => {
    setMutedValidationCodes([]);
    setValidationFixStatus("Cleared muted validation codes.");
  }, []);

  const unmuteValidationRule = useCallback((rule: string): void => {
    setMutedValidationRules((prev) => prev.filter((item) => item !== rule));
    const parsed = parseDiagnosticRuleKey(rule);
    setValidationFixStatus(`Unmuted diagnostic rule: ${parsed.code}`);
  }, []);

  const unmuteValidationCode = useCallback((code: string): void => {
    setMutedValidationCodes((prev) => prev.filter((item) => item !== code));
    setValidationFixStatus(`Unmuted diagnostic code: ${code}`);
  }, []);

  const navigateToDiagnostic = useCallback(
    (diagnostic: CompileDiagnostic): void => {
      const target = resolveDiagnosticTarget(diagnostic);
      if (!target) {
        return;
      }

      if (target.eventId && target.actionNodeId) {
        setFocusedGraphNode({
          eventId: target.eventId,
          nodeId: target.actionNodeId,
        });
      } else {
        setFocusedGraphNode(null);
      }

      if (target.openPromptEditor) {
        focusPromptEditor(target.componentId);
      } else {
        selectComponent(target.componentId);
      }

      canvasElement?.scrollIntoView({
        behavior: "smooth",
        block: "center",
      });
    },
    [canvasElement, focusPromptEditor, resolveDiagnosticTarget, selectComponent],
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
      setLastFixUndoState(null);
      setValidationFixStatus(null);
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
        mode: "overlay",
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
        builderPreferences: {
          mutedValidationRules: {
            kind: "form-first-builder-validation-muted-v1",
            rules: mutedValidationRules,
          },
          mutedValidationCodes: {
            kind: "form-first-builder-validation-muted-codes-v1",
            codes: mutedValidationCodes,
          },
          validationPrefs: {
            kind: "form-first-builder-validation-prefs-v1",
            showErrors: showValidationErrors,
            showWarnings: showValidationWarnings,
            showMuted: showMutedDiagnostics,
          },
        },
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
        builderPreferences: {
          mutedValidationRules: {
            kind: "form-first-builder-validation-muted-v1",
            rules: mutedValidationRules,
          },
          mutedValidationCodes: {
            kind: "form-first-builder-validation-muted-codes-v1",
            codes: mutedValidationCodes,
          },
          validationPrefs: {
            kind: "form-first-builder-validation-prefs-v1",
            showErrors: showValidationErrors,
            showWarnings: showValidationWarnings,
            showMuted: showMutedDiagnostics,
          },
        },
      });

      const warningSuffix = diagnosticsText ? `\n${diagnosticsText}` : "";
      setCompileSummary(
        `Exported bundle with ${localResult.fileContents.length} generated files locally (API fallback: ${(apiError as Error).message}).${warningSuffix}`,
      );
    }
  }, [
    mutedValidationCodes,
    mutedValidationRules,
    schema,
    showMutedDiagnostics,
    showValidationErrors,
    showValidationWarnings,
  ]);

  const exportDeployableBundle = useCallback(async (): Promise<void> => {
    setCompileSummary("Exporting deployable bundle...");

    try {
      const apiResult = await compileViaApi({
        app: schema,
        includeFileContents: true,
        mode: "bundle",
      });
      const diagnosticsText = formatDiagnostics(apiResult.diagnostics);

      setCompileSource("api");
      setCompileFiles(apiResult.files);

      if (apiResult.diagnostics.some((item) => item.severity === "error")) {
        setCompileSummary(
          `Cannot export deployable bundle due to compile errors:\n${diagnosticsText}`,
        );
        return;
      }

      if (!apiResult.fileContents || apiResult.fileContents.length === 0) {
        setCompileSummary(
          "Compile succeeded but no file contents were returned for deployable bundle export.",
        );
        return;
      }

      downloadJsonFile(`${schema.appId}-deployable-bundle.json`, {
        appId: schema.appId,
        version: schema.version,
        appDefinition: schema,
        target: "node-fastify-react",
        mode: "bundle",
        source: "api",
        generatedAt: apiResult.generatedAt,
        docker: apiResult.docker,
        diagnostics: apiResult.diagnostics,
        files: apiResult.fileContents,
      });

      const warningSuffix = diagnosticsText ? `\n${diagnosticsText}` : "";
      setCompileSummary(
        `Exported deployable bundle with ${apiResult.fileContents.length} files via API.${warningSuffix}`,
      );
    } catch (error) {
      setCompileSummary(
        `Export deployable bundle failed: ${(error as Error).message}. Ensure runtime API is running.`,
      );
    }
  }, [schema]);

  const exportDeployableTgz = useCallback(async (): Promise<void> => {
    setCompileSummary("Exporting deployable TGZ...");
    try {
      const blob = await fetchDeployableTgzViaApi({ app: schema });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${schema.appId}.tgz`;
      anchor.click();
      URL.revokeObjectURL(url);
      setCompileSummary("Exported deployable TGZ.");
    } catch (error) {
      setCompileSummary(`Export deployable TGZ failed: ${(error as Error).message}`);
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
        const payloadRecord =
          typeof payload === "object" && payload !== null
            ? (payload as Record<string, unknown>)
            : null;
        const candidate =
          payloadRecord
            ? (payloadRecord.appDefinition ?? payloadRecord.app ?? payload)
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
        const builderPreferences =
          payloadRecord &&
          typeof payloadRecord.builderPreferences === "object" &&
          payloadRecord.builderPreferences !== null
            ? (payloadRecord.builderPreferences as Record<string, unknown>)
            : null;
        const importedMutedRules = builderPreferences
          ? parseMutedValidationRules(builderPreferences.mutedValidationRules)
          : null;
        if (importedMutedRules) {
          setMutedValidationRules(importedMutedRules);
        }

        const importedMutedCodes = builderPreferences
          ? parseMutedValidationCodes(builderPreferences.mutedValidationCodes)
          : null;
        if (importedMutedCodes) {
          setMutedValidationCodes(importedMutedCodes);
        }

        const importedValidationPrefs = builderPreferences
          ? parseValidationPrefs(builderPreferences.validationPrefs)
          : null;
        if (importedValidationPrefs) {
          setShowValidationErrors(importedValidationPrefs.showErrors);
          setShowValidationWarnings(importedValidationPrefs.showWarnings);
          setShowMutedDiagnostics(importedValidationPrefs.showMuted);
        }
        setCompileSource("none");
        setCompileFiles([]);
        setLastFixUndoState(null);
        setValidationFixStatus(null);
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

    if (isPreviewBlockedByProvider) {
      setPreviewSummary(
        `Preview blocked: provider '${selectedPreviewProvider}' is unavailable (${selectedPreviewProviderStatus?.reason ?? "missing provider credentials"}). Enable override to continue anyway.`,
      );
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
  }, [
    isPreviewBlockedByProvider,
    previewStateDraft,
    schema,
    selectedPreviewEventId,
    selectedPreviewProvider,
    selectedPreviewProviderStatus,
  ]);

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

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.altKey || !event.shiftKey) {
        return;
      }
      if (isEditableKeyboardTarget(event.target)) {
        return;
      }

      const key = event.key.toLowerCase();
      if (key === "f") {
        event.preventDefault();
        applyAllValidationFixes();
        return;
      }
      if (key === "z") {
        event.preventDefault();
        undoLastFix();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [applyAllValidationFixes, undoLastFix]);

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
            <button
              onClick={() => void previewRuntime()}
              disabled={isPreviewBlockedByProvider}
            >
              Preview Runtime
            </button>
            <button onClick={() => void exportBundle()}>Export Bundle</button>
            <button onClick={() => void exportDeployableBundle()}>
              Export Deployable Bundle
            </button>
            <button onClick={() => void exportDeployableTgz()}>
              Export TGZ
            </button>
            <button
              onClick={() => {
                void (async () => {
                  try {
                    const result = await upsertProjectViaApi({
                      projectId: appId,
                      name: appId,
                      note: "saved from builder",
                      appDefinition: schema,
                      workspaceSnapshot: currentWorkspace,
                      previewStateDraft,
                      previewStateDirty,
                    });
                    setCompileSummary(
                      `Saved project '${result.project.id}' (version ${result.saved.id}).`,
                    );
                  } catch (error) {
                    setCompileSummary(
                      `Save project failed: ${(error as Error).message}`,
                    );
                  }
                })();
              }}
            >
              Save Server
            </button>
            <button
              onClick={() => {
                void (async () => {
                  try {
                    const loaded = await fetchProjectViaApi(appId);
                    const workspace = loaded.latest.workspaceSnapshot
                      ? parseBuilderWorkspaceSnapshot(loaded.latest.workspaceSnapshot)
                      : null;
                    if (workspace) {
                      loadWorkspaceSnapshot(workspace);
                    } else {
                      loadFromAppDefinition(loaded.latest.appDefinition);
                    }
                    if (loaded.latest.previewStateDraft) {
                      setPreviewStateDraft(loaded.latest.previewStateDraft);
                      setPreviewStateDirty(loaded.latest.previewStateDirty ?? false);
                    } else {
                      setPreviewStateDirty(false);
                    }
                    setCompileSummary(
                      `Loaded project '${loaded.project.id}' (${loaded.project.name}).`,
                    );
                  } catch (error) {
                    setCompileSummary(
                      `Load project failed: ${(error as Error).message}`,
                    );
                  }
                })();
              }}
            >
              Load Server
            </button>
            <button
              onClick={() => {
                void (async () => {
                  try {
                    const list = await listProjectsViaApi();
                    setCompileSummary(
                      list.projects.length > 0
                        ? `Server projects: ${list.projects
                            .map((p) => `${p.id} (${p.name})`)
                            .join(", ")}`
                        : "Server projects: (none)",
                    );
                  } catch (error) {
                    setCompileSummary(
                      `List projects failed: ${(error as Error).message}`,
                    );
                  }
                })();
              }}
            >
              List Server
            </button>
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
            <button
              onClick={() => {
                void (async () => {
                  try {
                    const status = await fetchProviderStatusViaApi();
                    setProviderStatus(status.providers);
                    const providerNames = (
                      Object.keys(status.providers) as SupportedModelProvider[]
                    )
                      .filter((provider) => status.providers[provider]?.available)
                      .join(", ");
                    setProviderStatusSummary(
                      providerNames.length > 0
                        ? `Providers ready: ${providerNames}`
                        : "No external providers configured. Mock is available.",
                    );
                  } catch (error) {
                    setProviderStatus(null);
                    setProviderStatusSummary(
                      `Provider status unavailable: ${(error as Error).message}`,
                    );
                  }
                })();
              }}
            >
              Refresh Providers
            </button>
            <button
              onClick={() => {
                void (async () => {
                  try {
                    const catalog = await fetchModelCatalogViaApi();
                    setModelCatalog(catalog.providers);
                    const openaiCount = catalog.providers.openai?.models?.length ?? 0;
                    const anthropicCount =
                      catalog.providers.anthropic?.models?.length ?? 0;
                    setModelCatalogSummary(
                      `Model catalog ready: openai ${openaiCount}, anthropic ${anthropicCount}.`,
                    );
                  } catch (error) {
                    setModelCatalog(null);
                    setModelCatalogSummary(
                      `Model catalog unavailable: ${(error as Error).message}`,
                    );
                  }
                })();
              }}
            >
              Refresh Models
            </button>
            <button onClick={saveSnapshot}>Save Snapshot</button>
            <button onClick={clearSnapshotHistory}>Clear History</button>
          </div>
        </header>
        <p className="meta">{autosaveStatus}</p>

        <section className="workspace">
          <Palette />
          <Canvas onCanvasElementChange={setCanvasElement} />
          <PromptEditor
            providerStatus={providerStatus}
            providerStatusSummary={providerStatusSummary}
            modelCatalog={modelCatalog}
            modelCatalogSummary={modelCatalogSummary}
          />
        </section>

        <section className="panel">
          <h2>Current App Schema</h2>
          <pre>{JSON.stringify(schema, null, 2)}</pre>
        </section>

        <section className="panel">
          <h2>Live Validation</h2>
          <div className="validation-filters">
            <label className="meta inline-toggle">
              <input
                type="checkbox"
                checked={showValidationErrors}
                onChange={(event) => setShowValidationErrors(event.target.checked)}
              />
              Show Errors
            </label>
            <label className="meta inline-toggle">
              <input
                type="checkbox"
                checked={showValidationWarnings}
                onChange={(event) => setShowValidationWarnings(event.target.checked)}
              />
              Show Warnings
            </label>
            <label className="meta inline-toggle">
              <input
                type="checkbox"
                checked={showMutedDiagnostics}
                onChange={(event) => setShowMutedDiagnostics(event.target.checked)}
              />
              Show Muted
            </label>
          </div>
          <div className="validation-toolbar">
            <button
              className="validation-clear-muted"
              onClick={clearMutedValidationRules}
              disabled={mutedValidationRules.length === 0}
            >
              Clear Muted Rules ({mutedValidationRules.length})
            </button>
            <button
              className="validation-clear-muted-codes"
              onClick={clearMutedValidationCodes}
              disabled={mutedValidationCodes.length === 0}
            >
              Clear Muted Codes ({mutedValidationCodes.length})
            </button>
            <button
              className="validation-apply-all"
              onClick={applyAllValidationFixes}
              disabled={availableValidationFixes.length === 0}
            >
              Apply All Fixes ({availableValidationFixes.length})
            </button>
            <button
              className="validation-undo"
              onClick={undoLastFix}
              disabled={!lastFixUndoState}
            >
              Undo Last Fix
            </button>
          </div>
          <p className="meta">{validationSummary}</p>
          <p className="meta">Shortcuts: Alt+Shift+F apply all fixes, Alt+Shift+Z undo last fix.</p>
          <p className="meta">
            Total diagnostics: {allValidationDiagnostics.length}. Visible:{" "}
            {validationDiagnostics.length}. Muted rules: {mutedValidationRules.length}.
            {" "}Muted codes: {mutedValidationCodes.length}.
          </p>
          {validationFixStatus && <p className="meta">{validationFixStatus}</p>}
          {validationCheckedAtMs && (
            <p className="meta">
              Last checked: {new Date(validationCheckedAtMs).toLocaleTimeString()}
            </p>
          )}
          {mutedValidationCodes.length > 0 && (
            <details className="muted-rules">
              <summary>Muted Codes</summary>
              <ul className="muted-rule-list">
                {mutedValidationCodes
                  .slice()
                  .sort()
                  .map((code) => (
                    <li key={code} className="muted-rule-item">
                      <div className="muted-rule-body">
                        <code>{code}</code>
                        <span className="meta">
                          Muted diagnostics: {mutedCodeCounts[code] ?? 0}
                        </span>
                      </div>
                      <button
                        className="validation-ignore"
                        onClick={() => unmuteValidationCode(code)}
                      >
                        Unmute
                      </button>
                    </li>
                  ))}
              </ul>
            </details>
          )}
          {mutedValidationRules.length > 0 && (
            <details className="muted-rules">
              <summary>Muted Rules</summary>
              <ul className="muted-rule-list">
                {mutedValidationRules.map((rule) => {
                  const parsed = parseDiagnosticRuleKey(rule);
                  return (
                    <li key={rule} className="muted-rule-item">
                      <div className="muted-rule-body">
                        <code>{parsed.code}</code>
                        {parsed.path && <code>{parsed.path}</code>}
                        {parsed.message && <span>{parsed.message}</span>}
                      </div>
                      <button
                        className="validation-ignore"
                        onClick={() => unmuteValidationRule(rule)}
                      >
                        Unmute
                      </button>
                    </li>
                  );
                })}
              </ul>
            </details>
          )}
          {validationDiagnostics.length > 0 && (
            <ul className="validation-list">
              {validationDiagnostics.map((diagnostic, index) => {
                const target = resolveDiagnosticTarget(diagnostic);
                const fix = resolveDiagnosticFix(diagnostic, target);
                const ruleKey = buildDiagnosticRuleKey(diagnostic);
                const mutedByRule = mutedRuleSet.has(ruleKey);
                const mutedByCode = mutedCodeSet.has(diagnostic.code);
                const muted = mutedByRule || mutedByCode;
                return (
                  <li
                    key={`${diagnostic.code}-${diagnostic.message}-${index}`}
                    className={`validation-item ${diagnostic.severity} ${
                      muted ? "muted" : ""
                    }`}
                  >
                    <div className="validation-header-row">
                      <code className="validation-code">
                        {diagnostic.severity.toUpperCase()} {diagnostic.code}
                      </code>
                      <div className="validation-action-row">
                        <button
                          className="validation-nav"
                          onClick={() => navigateToDiagnostic(diagnostic)}
                          disabled={!target}
                        >
                          Go to Canvas
                        </button>
                        <button
                          className="validation-ignore"
                          onClick={() =>
                            mutedByRule
                              ? unmuteValidationRule(ruleKey)
                              : ignoreDiagnosticRule(diagnostic)
                          }
                        >
                          {mutedByRule ? "Unmute Rule" : "Ignore Rule"}
                        </button>
                        <button
                          className="validation-ignore-code"
                          onClick={() =>
                            mutedByCode
                              ? unmuteValidationCode(diagnostic.code)
                              : ignoreDiagnosticCode(diagnostic)
                          }
                        >
                          {mutedByCode ? "Unmute Code" : "Ignore Code"}
                        </button>
                        {fix && (
                          <button
                            className="validation-fix"
                            onClick={() => applyFixWithUndo(fix)}
                          >
                            {fix.label}
                          </button>
                        )}
                      </div>
                    </div>
                    <span>{diagnostic.message}</span>
                    {diagnostic.path && (
                      <code className="validation-path">{diagnostic.path}</code>
                    )}
                    {target && (
                      <div className="meta">
                        Target component: <code>{target.componentId}</code>
                      </div>
                    )}
                    {target?.eventId && (
                      <div className="meta">
                        Target event: <code>{target.eventId}</code>
                      </div>
                    )}
                    {target?.actionNodeId && (
                      <div className="meta">
                        Target node: <code>{target.actionNodeId}</code>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="panel">
          <h2>Event Graph</h2>
          <p className="meta">
            Event: {selectedPreviewEvent?.id ?? "none"} (follows selected button)
          </p>
          {!selectedPreviewEvent ? (
            <p className="meta">No event available.</p>
          ) : (
            <>
              <ul className="event-node-list">
                {selectedPreviewEvent.actionGraph.nodes.map((node) => {
                  const focused =
                    focusedGraphNode?.eventId === selectedPreviewEvent.id &&
                    focusedGraphNode.nodeId === node.id;
                  return (
                    <li
                      key={node.id}
                      className={`event-node-item ${focused ? "focused" : ""}`}
                    >
                      <code>{node.id}</code>
                      <span className="meta">kind: {node.kind}</span>
                    </li>
                  );
                })}
              </ul>
              <div className="meta">Edges</div>
              <ul className="event-edge-list">
                {selectedPreviewEvent.actionGraph.edges.map((edge) => (
                  <li key={`${edge.from}-${edge.to}`}>
                    <code>{edge.from}</code>
                    <span className="meta">{" -> "}</span>
                    <code>{edge.to}</code>
                  </li>
                ))}
              </ul>
            </>
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
          {selectedPreviewProvider && (
            <p className="meta">
              Provider: <code>{selectedPreviewProvider}</code>{" "}
              {selectedPreviewProviderStatus
                ? selectedPreviewProviderStatus.available
                  ? "(ready)"
                  : `(unavailable: ${selectedPreviewProviderStatus.reason ?? "missing credentials"})`
                : "(status unknown)"}
            </p>
          )}
          <label className="meta inline-toggle">
            <input
              type="checkbox"
              checked={allowPreviewProviderOverride}
              onChange={(event) => setAllowPreviewProviderOverride(event.target.checked)}
            />
            Allow preview override when provider is unavailable
          </label>
          {isPreviewBlockedByProvider && (
            <p className="warning-inline">
              Preview is blocked until provider credentials are configured or override is enabled.
            </p>
          )}
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
            <button
              onClick={() => void previewRuntime()}
              disabled={isPreviewBlockedByProvider}
            >
              Run Preview
            </button>
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
