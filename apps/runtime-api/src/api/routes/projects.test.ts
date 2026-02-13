import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerBuilderRoutes } from "./builder.js";
import { defaultApp } from "../../domain/apps/default-app.js";

describe("builder project routes", () => {
  it("creates and fetches a project record", async () => {
    const dir = await mkdtemp(join(tmpdir(), "form-first-builder-"));
    process.env.FORM_BUILDER_DATA_DIR = dir;

    const app = Fastify();
    await registerBuilderRoutes(app);

    const projectId = "app_test_project_v1";

    const put = await app.inject({
      method: "PUT",
      url: `/builder/projects/${projectId}`,
      payload: {
        name: "Test Project",
        note: "initial",
        appDefinition: defaultApp,
        workspaceSnapshot: { appId: defaultApp.appId },
      },
    });

    expect(put.statusCode).toBe(200);
    const putBody = put.json() as { project: { id: string; latestVersionId: string } };
    expect(putBody.project.id).toBe(projectId);
    expect(typeof putBody.project.latestVersionId).toBe("string");

    const list = await app.inject({
      method: "GET",
      url: "/builder/projects",
    });
    expect(list.statusCode).toBe(200);
    const listBody = list.json() as { projects: Array<{ id: string }> };
    expect(listBody.projects.some((p) => p.id === projectId)).toBe(true);

    const get = await app.inject({
      method: "GET",
      url: `/builder/projects/${projectId}`,
    });
    expect(get.statusCode).toBe(200);
    const getBody = get.json() as { latest: { appDefinition: { appId: string } } };
    expect(getBody.latest.appDefinition.appId).toBe(defaultApp.appId);

    await app.close();
    await rm(dir, { recursive: true, force: true });
    delete process.env.FORM_BUILDER_DATA_DIR;
  });
});

