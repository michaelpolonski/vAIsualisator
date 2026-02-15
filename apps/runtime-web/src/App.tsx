import { useMemo, useState } from "react";
import { uiSchema } from "./generated/ui-schema.js";
import "./styles.css";

// Default to same-origin so the app works out-of-the-box when served by runtime-api on one port.
const apiBase = import.meta.env.VITE_RUNTIME_API_URL ?? "";

export function App(): JSX.Element {
  const [state, setState] = useState<Record<string, unknown>>({});
  const [status, setStatus] = useState("idle");
  const [logs, setLogs] = useState<Array<{ at: string; stage: string; message: string }>>(
    [],
  );

  const appTitle = useMemo(() => uiSchema.appId.replaceAll("_", " "), []);

  const validateInputsByEventId = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const event of uiSchema.events) {
      const validateNode = event.actionGraph.nodes.find((node) => node.kind === "Validate");
      if (validateNode && validateNode.kind === "Validate") {
        map.set(event.id, validateNode.input.stateKeys);
      }
    }
    return map;
  }, []);

  const stateShapeByKey = useMemo(() => uiSchema.stateModel, []);

  const runEvent = async (eventId: string): Promise<void> => {
    setStatus(`running: ${eventId}`);
    try {
      const response = await fetch(
        `${apiBase}/apps/${uiSchema.appId}/events/${eventId}/execute`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ state }),
        },
      );

      const body = (await response.json()) as
        | {
            statePatch: Record<string, unknown>;
            logs: Array<{ at: string; stage: string; message: string }>;
          }
        | { error?: string; message?: string };

      if (!response.ok) {
        const message =
          "message" in body && body.message
            ? body.message
            : "error" in body && body.error
              ? body.error
              : "Runtime call failed";
        throw new Error(message);
      }

      const okBody = body as {
        statePatch: Record<string, unknown>;
        logs: Array<{ at: string; stage: string; message: string }>;
      };

      setState((prev) => ({ ...prev, ...okBody.statePatch }));
      setLogs(okBody.logs);
      setStatus("done");
    } catch (error) {
      setStatus(`error: ${(error as Error).message}`);
    }
  };

  return (
    <main className="app">
      <header className="runtime-header">
        <div>
          <h1 className="runtime-title">{appTitle}</h1>
          <p className="runtime-meta">
            App: <code>{uiSchema.appId}</code> v{uiSchema.version}
          </p>
        </div>
        <div className="runtime-status">
          <span className="runtime-status-label">Status:</span> {status}
        </div>
      </header>

      <section className="runtime-grid">
        {uiSchema.ui.components.map((component) => {
          if (component.type === "TextArea") {
            const value = typeof state[component.stateKey] === "string" ? (state[component.stateKey] as string) : "";
            return (
              <label key={component.id} className="runtime-field">
                <span className="runtime-label">{component.label}</span>
                <textarea
                  className="runtime-textarea"
                  value={value}
                  onChange={(event) =>
                    setState((prev) => ({
                      ...prev,
                      [component.stateKey]: event.target.value,
                    }))
                  }
                  placeholder={`Enter ${component.label}...`}
                />
              </label>
            );
          }

          if (component.type === "Button") {
            const eventId = component.events.onClick;
            const required = eventId ? validateInputsByEventId.get(eventId) ?? [] : [];
            const missing = required.filter((key) => {
              const value = state[key];
              return value === undefined || value === null || value === "";
            });
            const disabled = !eventId || missing.length > 0 || status.startsWith("running:");

            return (
              <div key={component.id} className="runtime-button-wrap">
                <button
                  className="runtime-button"
                  disabled={disabled}
                  onClick={() => (eventId ? void runEvent(eventId) : undefined)}
                >
                  {component.label}
                </button>
                {missing.length > 0 && (
                  <div className="runtime-hint">
                    Missing: {missing.map((key) => <code key={key}>{key}</code>)}
                  </div>
                )}
              </div>
            );
          }

          if (component.type === "DataTable") {
            const rows = Array.isArray(state[component.dataKey]) ? (state[component.dataKey] as unknown[]) : [];
            const shape =
              stateShapeByKey[component.dataKey] && stateShapeByKey[component.dataKey]?.type === "array"
                ? (stateShapeByKey[component.dataKey] as { type: "array"; items: { type: "object"; shape: Record<string, unknown> } })
                : null;

            const columns = shape
              ? Object.keys(shape.items.shape)
              : Array.from(
                  new Set(
                    rows.flatMap((row) =>
                      row && typeof row === "object" ? Object.keys(row as Record<string, unknown>) : [],
                    ),
                  ),
                );

            return (
              <div key={component.id} className="runtime-table-wrap">
                <div className="runtime-table-title">{component.label}</div>
                {rows.length === 0 ? (
                  <div className="runtime-empty">No rows yet.</div>
                ) : (
                  <table className="runtime-table">
                    <thead>
                      <tr>
                        {columns.map((col) => (
                          <th key={col}>{col}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row, idx) => {
                        const rec = row && typeof row === "object" ? (row as Record<string, unknown>) : {};
                        return (
                          <tr key={idx}>
                            {columns.map((col) => (
                              <td key={col}>
                                {typeof rec[col] === "string" || typeof rec[col] === "number" || typeof rec[col] === "boolean"
                                  ? String(rec[col])
                                  : rec[col] === null || rec[col] === undefined
                                    ? ""
                                    : JSON.stringify(rec[col])}
                              </td>
                            ))}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </div>
            );
          }

          return null;
        })}
      </section>

      {logs.length > 0 && (
        <section className="runtime-logs">
          <h2>Execution Logs</h2>
          <ul className="runtime-log-list">
            {logs.map((item, idx) => (
              <li key={`${item.at}-${idx}`} className="runtime-log-item">
                <code>{item.stage}</code> {item.message}
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
