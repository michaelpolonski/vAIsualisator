import { useMemo, useState } from "react";
import { AppCompiler } from "@form-builder/compiler";
import { Palette } from "./palette/Palette.js";
import { Canvas } from "./canvas/Canvas.js";
import { PromptEditor } from "./prompt-editor/PromptEditor.js";
import { useBuilderStore } from "./state/builder-store.js";
import { toAppDefinition } from "./serializer/to-app-definition.js";
import "./styles.css";

export function App(): JSX.Element {
  const appId = useBuilderStore((state) => state.appId);
  const version = useBuilderStore((state) => state.version);
  const components = useBuilderStore((state) => state.components);

  const [compileSummary, setCompileSummary] = useState<string>("");

  const schema = useMemo(
    () =>
      toAppDefinition({
        appId,
        version,
        components,
      }),
    [appId, version, components],
  );

  async function compileNow(): Promise<void> {
    const compiler = new AppCompiler();
    const result = await compiler.compile({
      app: schema,
      target: "node-fastify-react",
    });

    if (result.diagnostics.length > 0) {
      const message = result.diagnostics
        .map((item) => `${item.severity.toUpperCase()} ${item.code}: ${item.message}`)
        .join("\n");
      setCompileSummary(message);
      return;
    }

    setCompileSummary(
      `Compiled ${result.files.length} artifacts. Docker image: ${result.docker.imageName}:latest`,
    );
  }

  return (
    <main className="layout">
      <header className="header">
        <h1>Form-First AI Builder</h1>
        <button onClick={compileNow}>Run / Deploy (F5)</button>
      </header>

      <section className="workspace">
        <Palette />
        <Canvas />
        <PromptEditor />
      </section>

      <section className="panel">
        <h2>Current App Schema</h2>
        <pre>{JSON.stringify(schema, null, 2)}</pre>
      </section>

      <section className="panel">
        <h2>Compilation Output</h2>
        <pre>{compileSummary || "No compile run yet."}</pre>
      </section>
    </main>
  );
}
