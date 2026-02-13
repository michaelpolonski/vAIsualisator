import { useState } from "react";
import { uiSchema } from "./generated/ui-schema.js";
import "./styles.css";

const apiBase = import.meta.env.VITE_RUNTIME_API_URL ?? "http://localhost:3000";

export function App(): JSX.Element {
  const [customerComplaint, setCustomerComplaint] = useState("");
  const [rows, setRows] = useState<Array<{ sentiment: string; reply: string }>>([]);
  const [status, setStatus] = useState("idle");

  async function runAnalyze(): Promise<void> {
    setStatus("running");
    try {
      const eventId = uiSchema.events[0]?.id;
      const response = await fetch(
        `${apiBase}/apps/${uiSchema.appId}/events/${eventId}/execute`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            state: {
              customerComplaint,
            },
          }),
        },
      );

      const body = (await response.json()) as {
        statePatch?: Record<string, unknown>;
        error?: string;
      };

      if (!response.ok) {
        throw new Error(body.error ?? "Runtime call failed");
      }

      const analysisRows = body.statePatch?.analysisRows;
      if (Array.isArray(analysisRows)) {
        setRows(
          analysisRows.map((item) => {
            const row = item as Record<string, unknown>;
            return {
              sentiment: String(row.sentiment ?? "unknown"),
              reply: String(row.reply ?? ""),
            };
          }),
        );
      }

      setStatus("done");
    } catch (error) {
      setStatus(`error: ${(error as Error).message}`);
    }
  }

  return (
    <main className="app">
      <h1>Customer Complaint Analyzer</h1>
      <label>
        Customer Complaint
        <textarea
          value={customerComplaint}
          onChange={(event) => setCustomerComplaint(event.target.value)}
        />
      </label>
      <button onClick={runAnalyze}>Analyze</button>
      <p>Status: {status}</p>

      <table>
        <thead>
          <tr>
            <th>Sentiment</th>
            <th>Reply</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${row.sentiment}-${index}`}>
              <td>{row.sentiment}</td>
              <td>{row.reply}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
