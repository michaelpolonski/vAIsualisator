import type { AppDefinition } from "@form-builder/contracts";
import type { CompilePlan, CompileInput } from "../types.js";

export function buildCompilePlan(input: CompileInput & { app: AppDefinition }): CompilePlan {
  return {
    app: input.app,
    target: input.target,
    outRoot: `generated/${input.app.appId}`,
  };
}
