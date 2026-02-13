#!/usr/bin/env node
import Fastify from "fastify";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { registerBuilderRoutes } from "../dist/apps/runtime-api/src/api/routes/builder.js";

function usage() {
  console.error(
    [
      "Usage:",
      "  node apps/runtime-api/scripts/generate-deployable-bundle.mjs <appDefinition.json> <outFile.json>",
      "",
      "Example:",
      "  node apps/runtime-api/scripts/generate-deployable-bundle.mjs examples/customer-complaint-app.json out/app_customer_support_v1-deployable-bundle.json",
      "",
      "Pre-req:",
      "  pnpm --filter @form-builder/runtime-api build",
      "",
    ].join("\n"),
  );
}

async function main() {
  const [appPath, outPath] = process.argv.slice(2);
  if (!appPath || !outPath) {
    usage();
    process.exit(1);
  }

  const appAbs = resolve(appPath);
  const outAbs = resolve(outPath);
  const raw = await readFile(appAbs, "utf8");
  const appDef = JSON.parse(raw);

  const server = Fastify();
  await registerBuilderRoutes(server);

  const response = await server.inject({
    method: "POST",
    url: "/builder/compile",
    payload: {
      app: appDef,
      mode: "bundle",
      includeFileContents: true,
    },
  });

  if (response.statusCode !== 200) {
    throw new Error(`Compile failed (${response.statusCode}): ${response.body}`);
  }

  const body = response.json();
  const fileContents = body.fileContents;
  if (!Array.isArray(fileContents) || fileContents.length === 0) {
    throw new Error("Compile succeeded but fileContents was empty.");
  }

  await mkdir(dirname(outAbs), { recursive: true });
  await writeFile(
    outAbs,
    JSON.stringify(
      {
        kind: "form-first-builder-deployable-bundle-v1",
        generatedAt: body.generatedAt,
        diagnostics: body.diagnostics,
        files: fileContents,
      },
      null,
      2,
    ),
    "utf8",
  );

  await server.close();
  console.log(
    `Wrote deployable bundle JSON (${fileContents.length} files) to ${outAbs}`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

