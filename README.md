# Form-First AI App Builder (MVP Scaffold)

This repository implements the foundational architecture for a form-first AI app builder:
- Visual builder: `apps/builder-web`
- Runtime web app: `apps/runtime-web`
- Runtime API: `apps/runtime-api`
- Shared contracts/schema: `packages/contracts`
- Compiler/transpiler: `packages/compiler`

## Architecture

The generated app is separated into:
- `presentation` (UI rendering/state controls)
- `application` (event handling + action graph execution)
- `domain` (typed app/event contracts)
- `infrastructure` (LLM provider adapters)
- `api` (stateless HTTP execution endpoints)

Prompt bindings are compiled into a typed action graph (`Validate -> PromptTask -> Transform`) so user-defined natural language logic never becomes ad-hoc inline script code.

## Folder structure

```text
apps/
  builder-web/
  runtime-api/
  runtime-web/
packages/
  contracts/
  compiler/
  ui-kit/
examples/
templates/
out/                            # compiler output
```

## Setup

```bash
pnpm install
```

## Run builder + runtime

```bash
pnpm --filter @form-builder/builder-web dev
pnpm --filter @form-builder/runtime-api dev
pnpm --filter @form-builder/runtime-web dev
```

## Validate implementation

```bash
pnpm -r typecheck
pnpm -r test
```

## Compile from schema example

```bash
pnpm --filter @form-builder/compiler compile:example
```

Generated artifacts are written under `out/generated/<appId>/`.
