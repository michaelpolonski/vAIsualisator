#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

function usage() {
  console.error(
    [
      "Usage:",
      "  node scripts/materialize-bundle.mjs <bundle.json> <outputDir>",
      "",
      "Notes:",
      "  - Expects a JSON payload containing a `files` array of { path, content }.",
      "  - Writes files under <outputDir>/<path>.",
      "",
    ].join("\n"),
  );
}

function isRecord(value) {
  return typeof value === "object" && value !== null;
}

async function main() {
  const [bundlePath, outDir] = process.argv.slice(2);
  if (!bundlePath || !outDir) {
    usage();
    process.exit(1);
  }

  const bundleAbs = resolve(bundlePath);
  const outAbs = resolve(outDir);

  const raw = await readFile(bundleAbs, "utf8");
  const payload = JSON.parse(raw);
  const record = isRecord(payload) ? payload : null;
  const files = record && Array.isArray(record.files) ? record.files : null;
  if (!files) {
    throw new Error("Invalid bundle: missing `files` array.");
  }

  for (const file of files) {
    if (!isRecord(file) || typeof file.path !== "string" || typeof file.content !== "string") {
      continue;
    }

    const target = resolve(outAbs, file.path);
    // Prevent path traversal outside outDir.
    if (target !== outAbs && !target.startsWith(outAbs + sep)) {
      throw new Error(`Refusing to write outside outputDir: ${file.path}`);
    }

    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content, "utf8");
  }

  console.log(`Materialized ${files.length} file(s) into ${outAbs}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
