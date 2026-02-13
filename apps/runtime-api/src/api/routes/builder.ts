import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AppCompiler } from "@form-builder/compiler";

const CompileBuilderRequestSchema = z.object({
  app: z.unknown(),
  target: z.literal("node-fastify-react").optional(),
  includeFileContents: z.boolean().optional(),
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
}
