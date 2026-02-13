import "dotenv/config";
import Fastify from "fastify";
import { registerEventRoutes } from "./api/routes/events.js";
import { registerBuilderRoutes } from "./api/routes/builder.js";

async function start(): Promise<void> {
  const app = Fastify({ logger: true });

  app.addHook("onRequest", async (request, reply) => {
    reply.header("access-control-allow-origin", "*");
    reply.header("access-control-allow-methods", "GET,POST,OPTIONS");
    reply.header("access-control-allow-headers", "content-type,authorization");

    if (request.method === "OPTIONS") {
      reply.code(204).send();
      return;
    }
  });

  app.get("/health", async () => ({ ok: true, at: new Date().toISOString() }));
  await registerBuilderRoutes(app);
  await registerEventRoutes(app);

  const port = Number(process.env.PORT ?? 3000);
  await app.listen({ host: "0.0.0.0", port });
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
