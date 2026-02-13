import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppCompiler } from "@form-builder/compiler";
import { readFile, readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import {
  AppDefinitionSchema,
  ExecuteEventResponseSchema,
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

export async function registerBuilderRoutes(app: FastifyInstance): Promise<void> {
  app.get("/builder/providers/status", async (_request, reply) => {
    return reply.send({
      providers: getProviderStatusSnapshot(process.env),
      checkedAt: new Date().toISOString(),
    });
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
