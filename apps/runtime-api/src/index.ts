import "dotenv/config";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { readFile, stat } from "node:fs/promises";
import { resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { registerEventRoutes } from "./api/routes/events.js";
import { registerBuilderRoutes } from "./api/routes/builder.js";

const MIME_BY_EXT: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

async function registerRuntimeWebStatic(app: FastifyInstance): Promise<void> {
  // When running from apps/runtime-api/dist/index.js, this points at the package root.
  const here = dirname(fileURLToPath(import.meta.url));
  const runtimeApiRoot = resolve(here, "..");
  const distDir = resolve(runtimeApiRoot, "../runtime-web/dist");
  const indexPath = resolve(distDir, "index.html");

  try {
    const indexStat = await stat(indexPath);
    if (!indexStat.isFile()) {
      return;
    }
  } catch {
    // No runtime-web build available (e.g. dev mode). Skip static hosting.
    return;
  }

  app.get("/", async (_request: FastifyRequest, reply: FastifyReply) => {
    const html = await readFile(indexPath);
    reply.header("cache-control", "no-cache");
    return reply.type(MIME_BY_EXT[".html"] ?? "text/html").send(html);
  });

  app.get("/*", async (request: FastifyRequest, reply: FastifyReply) => {
    const url = request.url.split("?", 1)[0] ?? "/";
    if (url.startsWith("/health") || url.startsWith("/builder") || url.startsWith("/apps")) {
      return reply.callNotFound();
    }

    const requested = decodeURIComponent(url);
    const candidate = resolve(distDir, `.${requested}`);
    if (!candidate.startsWith(distDir)) {
      return reply.status(400).send({ error: "INVALID_PATH" });
    }

    try {
      const fileStat = await stat(candidate);
      if (fileStat.isFile()) {
        const content = await readFile(candidate);
        const ext = extname(candidate).toLowerCase();
        const mime = MIME_BY_EXT[ext] ?? "application/octet-stream";
        reply.header("cache-control", ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable");
        return reply.type(mime).send(content);
      }
    } catch {
      // fallthrough to SPA index.html
    }

    const html = await readFile(indexPath);
    reply.header("cache-control", "no-cache");
    return reply.type(MIME_BY_EXT[".html"] ?? "text/html").send(html);
  });
}

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
  await registerRuntimeWebStatic(app);

  const port = Number(process.env.PORT ?? 3000);
  await app.listen({ host: "0.0.0.0", port });
}

start().catch((error) => {
  console.error(error);
  process.exit(1);
});
