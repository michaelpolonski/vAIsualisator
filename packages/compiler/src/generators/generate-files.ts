import type { CompilePlan, GeneratedFile } from "../types.js";

function stableJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function generateRuntimeApiAppDef(plan: CompilePlan): GeneratedFile {
  return {
    path: `${plan.outRoot}/runtime-api/src/generated/app-definition.ts`,
    content: `import type { AppDefinition } from "@form-builder/contracts";

export const appDefinition: AppDefinition = ${stableJson(plan.app)};
`,
  };
}

function generateRuntimeWebSchema(plan: CompilePlan): GeneratedFile {
  return {
    path: `${plan.outRoot}/runtime-web/src/generated/ui-schema.ts`,
    content: `import type { AppDefinition } from "@form-builder/contracts";

export const uiSchema: AppDefinition = ${stableJson(plan.app)};
`,
  };
}

function generateEventManifest(plan: CompilePlan): GeneratedFile {
  const eventIds = plan.app.events.map((event) => event.id);
  return {
    path: `${plan.outRoot}/runtime-api/src/generated/event-manifest.ts`,
    content: `export const eventIds = ${stableJson(eventIds)} as const;
`,
  };
}

function generateDockerfile(plan: CompilePlan): GeneratedFile {
  return {
    path: `${plan.outRoot}/Dockerfile`,
    content: `FROM node:22-alpine AS base
WORKDIR /app
COPY . .
RUN corepack enable && corepack prepare pnpm@10.0.0 --activate
RUN pnpm install --frozen-lockfile=false
RUN pnpm --filter @form-builder/contracts build
RUN pnpm --filter @form-builder/compiler build
RUN pnpm --filter @form-builder/runtime-api build
RUN pnpm --filter @form-builder/runtime-web build
EXPOSE 3000
CMD ["pnpm", "--filter", "@form-builder/runtime-api", "start"]
`,
  };
}

function generateDockerCompose(plan: CompilePlan): GeneratedFile {
  return {
    path: `${plan.outRoot}/docker-compose.yml`,
    content: `services:
  app:
    build: .
    ports:
      - "3000:3000"
    environment:
      PORT: "3000"
      OPENAI_API_KEY: \${OPENAI_API_KEY:-}
      ANTHROPIC_API_KEY: \${ANTHROPIC_API_KEY:-}
`,
  };
}

function generateEnvExample(plan: CompilePlan): GeneratedFile {
  return {
    path: `${plan.outRoot}/.env.example`,
    content: `# Copy to .env and fill in what you need.
PORT=3000

# Optional: enable real providers (mock works without these)
OPENAI_API_KEY=
ANTHROPIC_API_KEY=
`,
  };
}

function generateDeployReadme(plan: CompilePlan): GeneratedFile {
  return {
    path: `${plan.outRoot}/DEPLOY.md`,
    content: `# Deploy (${plan.app.appId})

## Quick start (Docker)

1. Copy \`.env.example\` to \`.env\` and set keys (optional)
2. Run:

\`\`\`bash
docker compose up --build
\`\`\`

Open:
- http://localhost:3000/ (UI)
- http://localhost:3000/health (API health)
`,
  };
}

export function generateFiles(plan: CompilePlan): GeneratedFile[] {
  return [
    generateRuntimeApiAppDef(plan),
    generateEventManifest(plan),
    generateRuntimeWebSchema(plan),
    generateDockerfile(plan),
    generateDockerCompose(plan),
    generateEnvExample(plan),
    generateDeployReadme(plan),
  ];
}
