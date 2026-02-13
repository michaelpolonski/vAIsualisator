import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppCompiler } from "@form-builder/compiler";
import {
  AppDefinitionSchema,
  ExecuteEventResponseSchema,
} from "@form-builder/contracts";
import { executeEvent } from "../../application/execute-event.js";
import { createProviderRegistry } from "../../infrastructure/provider-registry.js";

const CompileBuilderRequestSchema = z.object({
  app: z.unknown(),
  target: z.literal("node-fastify-react").optional(),
  includeFileContents: z.boolean().optional(),
});

const PreviewExecuteRequestSchema = z.object({
  app: z.unknown(),
  state: z.record(z.string(), z.unknown()),
});

export async function registerBuilderRoutes(app: FastifyInstance): Promise<void> {
  app.post("/builder/compile", async (request, reply) => {
    const payload = CompileBuilderRequestSchema.safeParse(request.body);
    if (!payload.success) {
      return reply.status(400).send({
        error: "INVALID_REQUEST",
        details: payload.error.issues,
      });
    }

    try {
      const compiler = new AppCompiler();
      const result = await compiler.compile({
        app: payload.data.app,
        target: payload.data.target ?? "node-fastify-react",
      });

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
