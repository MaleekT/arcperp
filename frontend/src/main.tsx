import { StrictMode, Component, type ReactNode, type ErrorInfo } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.js";

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: ErrorInfo) { console.error("[ArcPerp]", error, info); }
  render() {
    if (this.state.error) {
      return (
        <div role="alert" aria-live="assertive" style={{ padding: 32, fontFamily: "monospace", color: "#FF3B6B", background: "#0A0F1E", minHeight: "100vh" }}>
          <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 12 }}>ArcPerp failed to render</div>
          <pre style={{ fontSize: 12, whiteSpace: "pre-wrap", color: "#E2E8F0" }}>{this.state.error?.message ?? "Unknown error"}</pre>
          <button onClick={() => this.setState({ error: null })} style={{ marginTop: 16, padding: "8px 16px", background: "#00D4C8", color: "#0A0F1E", border: "none", borderRadius: 8, cursor: "pointer", fontWeight: 600 }}>
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("Root element #root not found in HTML");

createRoot(root).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>
);
