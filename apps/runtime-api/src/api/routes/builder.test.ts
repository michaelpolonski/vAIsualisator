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
});
