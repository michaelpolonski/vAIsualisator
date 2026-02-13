import { parseAndValidate } from "./parser/parse-and-validate.js";
import { normalizeToIR } from "./ir/normalize.js";
import { buildCompilePlan } from "./planner/build-compile-plan.js";
import { generateFiles } from "./generators/generate-files.js";
import type { CompileInput, CompileOutput } from "./types.js";

export class AppCompiler {
  async compile(input: CompileInput): Promise<CompileOutput> {
    const parsed = parseAndValidate(input.app);
    if (!parsed.app || parsed.diagnostics.some((item) => item.severity === "error")) {
      return {
        files: [],
        diagnostics: parsed.diagnostics,
        docker: { imageName: "", tags: [] },
      };
    }

    const ir = normalizeToIR(parsed.app);
    const plan = buildCompilePlan({ ...input, app: ir });
    const files = generateFiles(plan);

    return {
      files,
      diagnostics: parsed.diagnostics,
      docker: { imageName: `app-${ir.appId}`, tags: ["latest"] },
    };
  }
}

export * from "./types.js";
