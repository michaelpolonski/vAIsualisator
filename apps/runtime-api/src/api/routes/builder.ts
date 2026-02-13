import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppCompiler } from "@form-builder/compiler";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import {
  AppDefinitionSchema,
  ExecuteEventResponseSchema,
  type AppDefinition,
} from "@form-builder/contracts";
import { executeEvent } from "../../application/execute-event.js";
import {
  createProviderRegistry,
  getProviderStatusSnapshot,
} from "../../infrastructure/provider-registry.js";

const CompileBuilderRequestSchema = z.object({
  app: z.unknown(),
  target: z.literal("node-fastify-react").optional(),
  mode: z.enum(["overlay", "bundle"]).optional(),
  includeFileContents: z.boolean().optional(),
});

const PreviewExecuteRequestSchema = z.object({
  app: z.unknown(),
  state: z.record(z.string(), z.unknown()),
});

const ProjectUpsertRequestSchema = z.object({
  name: z.string().min(1).optional(),
  note: z.string().optional(),
  appDefinition: z.unknown(),
  workspaceSnapshot: z.unknown().optional(),
  previewStateDraft: z.string().optional(),
  previewStateDirty: z.boolean().optional(),
});

function requireApiKey(request: { headers: Record<string, string | string[] | undefined> }): void {
  const expected = process.env.FORM_BUILDER_API_KEY?.trim();
  if (!expected) {
    return;
  }
  const auth = request.headers.authorization;
  const value = Array.isArray(auth) ? auth[0] : auth;
  if (!value || !value.startsWith("Bearer ")) {
    throw new Error("Missing Authorization bearer token.");
  }
  const token = value.slice("Bearer ".length).trim();
  if (token !== expected) {
    throw new Error("Invalid Authorization bearer token.");
  }
}

function isSafeProjectId(projectId: string): boolean {
  return /^[a-zA-Z0-9_-]{3,80}$/.test(projectId);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path, "utf8");
    return true;
  } catch {
    return false;
  }
}

async function findRepoRoot(startDir: string): Promise<string> {
  let current = resolve(startDir);
  for (let hops = 0; hops < 10; hops += 1) {
    const marker = join(current, "pnpm-workspace.yaml");
    if (await fileExists(marker)) {
      return current;
    }
    const parent = resolve(current, "..");
    if (parent === current) {
      break;
    }
    current = parent;
  }
  throw new Error(
    "Could not locate repo root (missing pnpm-workspace.yaml within 10 parent directories).",
  );
}

function resolveDataDir(): string {
  const configured = process.env.FORM_BUILDER_DATA_DIR?.trim();
  if (configured) {
    return resolve(configured);
  }
  // Default: alongside runtime-api when running from apps/runtime-api.
  return resolve(process.cwd(), "data");
}

async function writeJsonFile(path: string, payload: unknown): Promise<void> {
  await mkdir(resolve(path, ".."), { recursive: true });
  await writeFile(path, JSON.stringify(payload, null, 2), "utf8");
}

async function readJsonFile(path: string): Promise<unknown> {
  const raw = await readFile(path, "utf8");
  return JSON.parse(raw) as unknown;
}

interface ProjectIndexEntry {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  latestVersionId: string;
}

interface ProjectVersionIndexEntry {
  id: string;
  savedAt: string;
  note?: string | undefined;
}

interface ProjectMetaV1 extends ProjectIndexEntry {
  kind: "form-first-builder-project-v1";
  versions: ProjectVersionIndexEntry[];
}

interface ProjectVersionV1 {
  kind: "form-first-builder-project-version-v1";
  id: string;
  savedAt: string;
  appDefinition: AppDefinition;
  workspaceSnapshot?: unknown | undefined;
  previewStateDraft?: string | undefined;
  previewStateDirty?: boolean | undefined;
  note?: string | undefined;
}

async function collectTextFiles(args: {
  baseDir: string;
  include: string;
  excludeDirs?: string[];
}): Promise<Array<{ relPath: string; content: string }>> {
  const root = resolve(args.baseDir, args.include);
  const excluded = new Set(args.excludeDirs ?? []);

  const walk = async (dir: string): Promise<Array<{ relPath: string; content: string }>> => {
    const entries = await readdir(dir, { withFileTypes: true });
    const results: Array<{ relPath: string; content: string }> = [];

    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }

      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (excluded.has(entry.name)) {
          continue;
        }
        results.push(...(await walk(full)));
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const relPath = relative(args.baseDir, full).replaceAll("\\", "/");
      const content = await readFile(full, "utf8");
      results.push({ relPath, content });
    }

    return results;
  };

  return walk(root);
}

function createBundleRootPackageJson(appId: string): string {
  return JSON.stringify(
    {
      name: `form-first-generated-${appId}`,
      private: true,
      version: "0.1.0",
      packageManager: "pnpm@10.0.0",
      scripts: {
        dev: "pnpm -r dev",
        build: "pnpm -r build",
        start: "pnpm --filter @form-builder/runtime-api start",
      },
    },
    null,
    2,
  );
}

function createWorkspaceYaml(): string {
  return ["packages:", "  - \"apps/*\"", "  - \"packages/*\"", ""].join("\n");
}

function parseModelCatalogEnv(value: string | undefined): string[] {
  const raw = (value ?? "").trim();
  if (!raw) {
    return [];
  }

  if (raw.startsWith("[")) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        return parsed
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter(Boolean);
      }
    } catch {
      // fall through to delimiter parsing
    }
  }

  return raw
    .split(/[\n,]+/g)
    .map((item) => item.trim())
    .filter(Boolean);
}

export async function registerBuilderRoutes(app: FastifyInstance): Promise<void> {
  app.get("/builder/providers/status", async (_request, reply) => {
    return reply.send({
      providers: getProviderStatusSnapshot(process.env),
      checkedAt: new Date().toISOString(),
    });
  });

  app.get("/builder/models/catalog", async (_request, reply) => {
    const openaiModels = parseModelCatalogEnv(process.env.FORM_BUILDER_OPENAI_MODELS);
    const anthropicModels = parseModelCatalogEnv(
      process.env.FORM_BUILDER_ANTHROPIC_MODELS,
    );

    const openaiDefault =
      process.env.FORM_BUILDER_OPENAI_DEFAULT_MODEL?.trim() ||
      openaiModels[0] ||
      "gpt-5.2";
    const anthropicDefault =
      process.env.FORM_BUILDER_ANTHROPIC_DEFAULT_MODEL?.trim() ||
      anthropicModels[0] ||
      "claude-sonnet-4-0";

    return reply.send({
      providers: {
        mock: { defaultModel: "mock-v1", models: ["mock-v1"] },
        openai: {
          defaultModel: openaiDefault,
          models: openaiModels.length > 0 ? openaiModels : [openaiDefault],
        },
        anthropic: {
          defaultModel: anthropicDefault,
          models: anthropicModels.length > 0 ? anthropicModels : [anthropicDefault],
        },
      },
      fetchedAt: new Date().toISOString(),
      source: {
        openai: openaiModels.length > 0 ? "env" : "default",
        anthropic: anthropicModels.length > 0 ? "env" : "default",
      },
    });
  });

  app.get("/builder/projects", async (request, reply) => {
    try {
      requireApiKey(request);
      const dataDir = resolveDataDir();
      const root = join(dataDir, "projects");
      await mkdir(root, { recursive: true });

      const entries = await readdir(root, { withFileTypes: true });
      const projects: ProjectIndexEntry[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        const projectId = entry.name;
        if (!isSafeProjectId(projectId)) {
          continue;
        }
        const metaPath = join(root, projectId, "project.json");
        try {
          const meta = (await readJsonFile(metaPath)) as unknown;
          if (!meta || typeof meta !== "object") {
            continue;
          }
          const record = meta as Record<string, unknown>;
          if (record.kind !== "form-first-builder-project-v1") {
            continue;
          }
          if (
            typeof record.id !== "string" ||
            typeof record.name !== "string" ||
            typeof record.createdAt !== "string" ||
            typeof record.updatedAt !== "string" ||
            typeof record.latestVersionId !== "string"
          ) {
            continue;
          }
          projects.push({
            id: record.id,
            name: record.name,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
            latestVersionId: record.latestVersionId,
          });
        } catch {
          continue;
        }
      }

      return reply.send({ projects, at: new Date().toISOString() });
    } catch (error) {
      return reply.status(401).send({
        error: "UNAUTHORIZED",
        message: (error as Error).message,
      });
    }
  });

  app.get("/builder/projects/:projectId", async (request, reply) => {
    try {
      requireApiKey(request);
      const params = request.params as { projectId?: string };
      const projectId = params.projectId;
      if (!projectId || !isSafeProjectId(projectId)) {
        return reply.status(400).send({ error: "INVALID_PROJECT_ID" });
      }

      const dataDir = resolveDataDir();
      const metaPath = join(dataDir, "projects", projectId, "project.json");
      const meta = (await readJsonFile(metaPath)) as ProjectMetaV1;
      if (!meta || meta.kind !== "form-first-builder-project-v1") {
        return reply.status(404).send({ error: "PROJECT_NOT_FOUND" });
      }

      const latest = meta.latestVersionId;
      const versionPath = join(
        dataDir,
        "projects",
        projectId,
        "versions",
        `${latest}.json`,
      );
      const version = (await readJsonFile(versionPath)) as ProjectVersionV1;
      if (!version || version.kind !== "form-first-builder-project-version-v1") {
        return reply.status(500).send({ error: "PROJECT_VERSION_CORRUPT" });
      }

      return reply.send({ project: meta, latest: version });
    } catch (error) {
      const message = (error as Error).message;
      const code = message.includes("Authorization") ? 401 : 500;
      return reply.status(code).send({
        error: code === 401 ? "UNAUTHORIZED" : "PROJECT_READ_FAILED",
        message,
      });
    }
  });

  app.put("/builder/projects/:projectId", async (request, reply) => {
    try {
      requireApiKey(request);
      const params = request.params as { projectId?: string };
      const projectId = params.projectId;
      if (!projectId || !isSafeProjectId(projectId)) {
        return reply.status(400).send({ error: "INVALID_PROJECT_ID" });
      }

      const payload = ProjectUpsertRequestSchema.safeParse(request.body);
      if (!payload.success) {
        return reply.status(400).send({
          error: "INVALID_REQUEST",
          details: payload.error.issues,
        });
      }

      const parsedApp = AppDefinitionSchema.safeParse(payload.data.appDefinition);
      if (!parsedApp.success) {
        return reply.status(400).send({
          error: "INVALID_APP_DEFINITION",
          details: parsedApp.error.issues,
        });
      }

      const dataDir = resolveDataDir();
      const projectDir = join(dataDir, "projects", projectId);
      const versionsDir = join(projectDir, "versions");
      await mkdir(versionsDir, { recursive: true });

      const metaPath = join(projectDir, "project.json");
      const now = new Date().toISOString();
      const versionId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      let meta: ProjectMetaV1 | null = null;
      try {
        const loaded = (await readJsonFile(metaPath)) as ProjectMetaV1;
        if (loaded && loaded.kind === "form-first-builder-project-v1") {
          meta = loaded;
        }
      } catch {
        meta = null;
      }

      const nextMeta: ProjectMetaV1 = meta
        ? {
            ...meta,
            name: payload.data.name?.trim() || meta.name,
            updatedAt: now,
            latestVersionId: versionId,
            versions: [
              { id: versionId, savedAt: now, note: payload.data.note },
              ...meta.versions,
            ].slice(0, 50),
          }
        : {
            kind: "form-first-builder-project-v1",
            id: projectId,
            name: payload.data.name?.trim() || projectId,
            createdAt: now,
            updatedAt: now,
            latestVersionId: versionId,
            versions: [{ id: versionId, savedAt: now, note: payload.data.note }],
          };

      const version: ProjectVersionV1 = {
        kind: "form-first-builder-project-version-v1",
        id: versionId,
        savedAt: now,
        appDefinition: parsedApp.data,
        workspaceSnapshot: payload.data.workspaceSnapshot,
        previewStateDraft: payload.data.previewStateDraft,
        previewStateDirty: payload.data.previewStateDirty,
        note: payload.data.note,
      };

      await writeJsonFile(metaPath, nextMeta);
      await writeJsonFile(join(versionsDir, `${versionId}.json`), version);

      return reply.send({ project: nextMeta, saved: version });
    } catch (error) {
      const message = (error as Error).message;
      const code = message.includes("Authorization") ? 401 : 500;
      return reply.status(code).send({
        error: code === 401 ? "UNAUTHORIZED" : "PROJECT_WRITE_FAILED",
        message,
      });
    }
  });

  app.post("/builder/compile", async (request, reply) => {
    const payload = CompileBuilderRequestSchema.safeParse(request.body);
    if (!payload.success) {
      return reply.status(400).send({
        error: "INVALID_REQUEST",
        details: payload.error.issues,
      });
    }

    try {
      const mode = payload.data.mode ?? "overlay";
      const compiler = new AppCompiler();
      const result = await compiler.compile({
        app: payload.data.app,
        target: payload.data.target ?? "node-fastify-react",
      });

      if (mode === "bundle") {
        const includeContents = payload.data.includeFileContents ?? false;
        if (!includeContents) {
          return reply.status(400).send({
            error: "INVALID_REQUEST",
            message: "Bundle mode requires includeFileContents=true.",
          });
        }

        const parsedApp = AppDefinitionSchema.safeParse(payload.data.app);
        if (!parsedApp.success) {
          return reply.status(400).send({
            error: "INVALID_APP_DEFINITION",
            details: parsedApp.error.issues,
          });
        }

        const repoRoot = await findRepoRoot(process.cwd());
        const bundleRoot = `bundle/${parsedApp.data.appId}`;

        const scaffold = (
          await Promise.all([
            collectTextFiles({
              baseDir: repoRoot,
              include: "apps/runtime-api",
              excludeDirs: ["node_modules", "dist"],
            }),
            collectTextFiles({
              baseDir: repoRoot,
              include: "apps/runtime-web",
              excludeDirs: ["node_modules", "dist"],
            }),
            collectTextFiles({
              baseDir: repoRoot,
              include: "packages/contracts",
              excludeDirs: ["node_modules", "dist"],
            }),
            collectTextFiles({
              baseDir: repoRoot,
              include: "packages/compiler",
              excludeDirs: ["node_modules", "dist"],
            }),
          ])
        ).flat();

        const rootTsconfig = await readFile(join(repoRoot, "tsconfig.base.json"), "utf8");
        const rootFiles: Array<{ relPath: string; content: string }> = [
          { relPath: "package.json", content: createBundleRootPackageJson(parsedApp.data.appId) },
          { relPath: "pnpm-workspace.yaml", content: createWorkspaceYaml() },
          { relPath: "tsconfig.base.json", content: rootTsconfig },
        ];

        const overlaysBySuffix = new Map<string, { relPath: string; content: string }>();
        for (const file of result.files) {
          if (file.path.endsWith("/runtime-api/src/generated/app-definition.ts")) {
            overlaysBySuffix.set("apps/runtime-api/src/generated/app-definition.ts", {
              relPath: "apps/runtime-api/src/generated/app-definition.ts",
              content: file.content,
            });
          }
          if (file.path.endsWith("/runtime-api/src/generated/event-manifest.ts")) {
            overlaysBySuffix.set("apps/runtime-api/src/generated/event-manifest.ts", {
              relPath: "apps/runtime-api/src/generated/event-manifest.ts",
              content: file.content,
            });
          }
          if (file.path.endsWith("/runtime-web/src/generated/ui-schema.ts")) {
            overlaysBySuffix.set("apps/runtime-web/src/generated/ui-schema.ts", {
              relPath: "apps/runtime-web/src/generated/ui-schema.ts",
              content: file.content,
            });
          }
          if (file.path.endsWith("/Dockerfile")) {
            overlaysBySuffix.set("Dockerfile", { relPath: "Dockerfile", content: file.content });
          }
        }

        const overlayPaths = new Set<string>([...overlaysBySuffix.keys()]);
        const fileContents = [
          ...rootFiles,
          ...scaffold.filter((item) => !overlayPaths.has(item.relPath)),
          ...[...overlaysBySuffix.values()],
        ].map((file) => ({
          path: `${bundleRoot}/${file.relPath}`,
          content: file.content,
        }));

        return reply.send({
          diagnostics: result.diagnostics,
          docker: { imageName: `app-${parsedApp.data.appId}`, tags: ["latest"] },
          files: fileContents.map((file) => ({
            path: file.path,
            bytes: Buffer.byteLength(file.content, "utf8"),
          })),
          fileContents,
          generatedAt: new Date().toISOString(),
        });
      }

      return reply.send({
        diagnostics: result.diagnostics,
        docker: result.docker,
        files: result.files.map((file) => ({
          path: file.path,
          bytes: Buffer.byteLength(file.content, "utf8"),
        })),
        fileContents: payload.data.includeFileContents
          ? result.files.map((file) => ({
              path: file.path,
              content: file.content,
            }))
          : undefined,
        generatedAt: new Date().toISOString(),
      });
    } catch (error) {
      return reply.status(500).send({
        error: "COMPILE_FAILED",
        message: (error as Error).message,
      });
    }
  });

  app.post("/builder/preview/events/:eventId/execute", async (request, reply) => {
    const payload = PreviewExecuteRequestSchema.safeParse(request.body);
    if (!payload.success) {
      return reply.status(400).send({
        error: "INVALID_REQUEST",
        details: payload.error.issues,
      });
    }

    const parsedApp = AppDefinitionSchema.safeParse(payload.data.app);
    if (!parsedApp.success) {
      return reply.status(400).send({
        error: "INVALID_APP_DEFINITION",
        details: parsedApp.error.issues,
      });
    }

    const params = request.params as { eventId?: string };
    const eventId = params.eventId;
    if (!eventId) {
      return reply.status(400).send({ error: "MISSING_EVENT_ID" });
    }

    try {
      const providers = createProviderRegistry(process.env);
      const result = await executeEvent(
        parsedApp.data,
        eventId,
        payload.data.state,
        providers,
      );
      const validated = ExecuteEventResponseSchema.parse(result);
      return reply.send(validated);
    } catch (error) {
      return reply.status(500).send({
        error: "PREVIEW_EXECUTION_FAILED",
        message: (error as Error).message,
      });
    }
  });
}
