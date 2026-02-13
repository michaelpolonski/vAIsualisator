import type { FastifyInstance } from "fastify";
import {
  ExecuteEventRequestSchema,
  ExecuteEventResponseSchema,
} from "@form-builder/contracts";
import { getAppDefinition } from "../../domain/app-registry.js";
import { executeEvent } from "../../application/execute-event.js";
import { createProviderRegistry } from "../../infrastructure/provider-registry.js";

export async function registerEventRoutes(app: FastifyInstance): Promise<void> {
  app.post("/apps/:appId/events/:eventId/execute", async (request, reply) => {
    const payload = ExecuteEventRequestSchema.safeParse(request.body);
    if (!payload.success) {
      return reply.status(400).send({
        error: "INVALID_REQUEST",
        details: payload.error.issues,
      });
    }

    const params = request.params as { appId?: string; eventId?: string };
    const appId = params.appId;
    const eventId = params.eventId;

    if (!appId || !eventId) {
      return reply.status(400).send({ error: "MISSING_ROUTE_PARAMS" });
    }

    const appDef = getAppDefinition(appId);
    if (!appDef) {
      return reply.status(404).send({ error: `App '${appId}' not found.` });
    }

    const providers = createProviderRegistry(process.env);
    try {
      const result = await executeEvent(appDef, eventId, payload.data.state, providers);
      const response = ExecuteEventResponseSchema.parse(result);
      return reply.send(response);
    } catch (error) {
      return reply.status(500).send({
        error: "EVENT_EXECUTION_FAILED",
        message: (error as Error).message,
      });
    }
  });
}
