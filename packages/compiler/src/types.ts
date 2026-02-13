import type { AppDefinition } from "@form-builder/contracts";

export type DiagnosticSeverity = "error" | "warning";

export interface Diagnostic {
  code: string;
  message: string;
  severity: DiagnosticSeverity;
  path?: string;
}

export interface GeneratedFile {
  path: string;
  content: string;
}

export interface CompileInput {
  app: unknown;
  target: "node-fastify-react";
}

export interface CompileOutput {
  files: GeneratedFile[];
  diagnostics: Diagnostic[];
  docker: {
    imageName: string;
    tags: string[];
  };
}

export interface CompilePlan {
  app: AppDefinition;
  target: "node-fastify-react";
  outRoot: string;
}
