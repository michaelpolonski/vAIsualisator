import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { AppCompiler } from "./index.js";

async function main(): Promise<void> {
  const projectRoot = resolve(import.meta.dirname, "../../..");
  const examplePath = resolve(projectRoot, "examples/customer-complaint-app.json");
  const outputRoot = resolve(projectRoot, "out");

  const source = await readFile(examplePath, "utf8");
  const app = JSON.parse(source) as unknown;

  const compiler = new AppCompiler();
  const result = await compiler.compile({
    app,
    target: "node-fastify-react",
  });

  if (result.diagnostics.some((d) => d.severity === "error")) {
    for (const diag of result.diagnostics) {
      console.error(`[${diag.severity}] ${diag.code}: ${diag.message}`);
    }
    process.exit(1);
  }

  for (const file of result.files) {
    const absolutePath = resolve(outputRoot, file.path);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, file.content, "utf8");
  }

  console.log(`Generated ${result.files.length} files into ${outputRoot}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
