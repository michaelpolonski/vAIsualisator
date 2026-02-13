import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { registerBuilderRoutes } from "./builder.js";
import { defaultApp } from "../../domain/apps/default-app.js";

describe("builder compile route", () => {
  it("compiles app schema and returns file metadata", async () => {
    const app = Fastify();
    await registerBuilderRoutes(app);

    const response = await app.inject({
      method: "POST",
      url: "/builder/compile",
      payload: {
        app: defaultApp,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      diagnostics: Array<{ severity: string }>;
      files: Array<{ path: string; bytes: number }>;
      docker: { imageName: string };
    };

    expect(body.diagnostics.some((item) => item.severity === "error")).toBe(false);
    expect(body.files.length).toBeGreaterThan(0);
    expect(body.files[0]?.path).toContain("generated");
    expect(body.docker.imageName).toContain("app_");

    await app.close();
  });

  it("returns generated file contents when requested", async () => {
    const app = Fastify();
    await registerBuilderRoutes(app);

    const response = await app.inject({
      method: "POST",
      url: "/builder/compile",
      payload: {
        app: defaultApp,
        includeFileContents: true,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      files: Array<{ path: string; bytes: number }>;
      fileContents?: Array<{ path: string; content: string }>;
    };

    expect(body.fileContents).toBeDefined();
    expect(body.fileContents?.length).toBe(body.files.length);
    expect(body.fileContents?.[0]?.content.length).toBeGreaterThan(0);

    await app.close();
  });

  it("executes preview event and returns state patch/logs", async () => {
    const app = Fastify();
    await registerBuilderRoutes(app);

    const response = await app.inject({
      method: "POST",
      url: "/builder/preview/events/evt_analyze_click/execute",
      payload: {
        app: defaultApp,
        state: {
          customerComplaint: "The response time was too slow.",
        },
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      statePatch: Record<string, unknown>;
      logs: Array<{ stage: string }>;
    };

    expect(Array.isArray(body.statePatch.analysisRows)).toBe(true);
    expect(body.logs.length).toBeGreaterThan(0);
    expect(body.logs.some((item) => item.stage === "prompt")).toBe(true);

    await app.close();
  });
});
