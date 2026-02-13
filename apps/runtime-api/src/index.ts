import "dotenv/config";
import Fastify from "fastify";
import { registerEventRoutes } from "./api/routes/events.js";

async function start(): Promise<void> {
  const app = Fastify({ logger: true });

  app.get("/health", async () => ({ ok: true, at: new Date().toISOString() }));
  await registerEventRoutes(app);

  const port = Number(process.env.PORT ?? 3000);
  await app.listen({ host: "0.0.0.0", port });
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
