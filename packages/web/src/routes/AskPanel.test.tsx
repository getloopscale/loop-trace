import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider, violetForge } from "@theokit/ui";
import { AskPanel } from "./AskPanel.js";
import * as client from "../api/client.js";

vi.mock("../api/client.js", async (orig) => {
  const actual = await orig<typeof import("../api/client.js")>();
  return { ...actual, askCopilot: vi.fn() };
});

function renderPanel(spanId?: string) {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ThemeProvider defaultTheme="violet-forge" defaultMode="dark" themes={[violetForge]}>
        <AskPanel traceId="t1" spanId={spanId} />
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("M33 AskPanel (T4.1)", () => {
  it("test_ask_panel_submits_and_renders_answer", async () => {
    vi.mocked(client.askCopilot).mockResolvedValue({ answer: "It timed out on the tool call." });
    const user = userEvent.setup();
    renderPanel("s1");
    await user.type(screen.getByLabelText("question"), "why did it fail?");
    await user.click(screen.getByRole("button", { name: "Ask" }));
    await waitFor(() =>
      expect(client.askCopilot).toHaveBeenCalledWith("t1", { question: "why did it fail?", spanId: "s1" }),
    );
    expect(await screen.findByText("It timed out on the tool call.")).toBeInTheDocument();
  });

  it("test_ask_panel_renders_error_state_on_failure", async () => {
    vi.mocked(client.askCopilot).mockRejectedValue(new client.ApiError(503));
    const user = userEvent.setup();
    renderPanel("s1");
    await user.type(screen.getByLabelText("question"), "why?");
    await user.click(screen.getByRole("button", { name: "Ask" }));
    // 503 = copilot not configured → a clear alert, never a fabricated answer (D2).
    expect(await screen.findByRole("alert")).toHaveTextContent("not configured");
  });

  it("test_ask_panel_renders_answer_via_xss_safe_markdown", async () => {
    // EC-8: the answer flows through the sanitized MarkdownText renderer — a
    // <script> in the model output is inert (react-markdown builds an element tree,
    // rehype-sanitize strips scripts), and markdown emphasis is parsed, not raw.
    vi.mocked(client.askCopilot).mockResolvedValue({
      answer: "**bold** answer <script>alert(1)</script>",
    });
    const user = userEvent.setup();
    const { container } = renderPanel("s1");
    await user.type(screen.getByLabelText("question"), "q");
    await user.click(screen.getByRole("button", { name: "Ask" }));
    expect(await screen.findByText("bold")).toBeInTheDocument(); // markdown parsed
    expect(container.querySelector("script")).toBeNull(); // script stripped (EC-8)
  });

  it("test_ask_panel_scopes_to_trace_when_no_span", async () => {
    vi.mocked(client.askCopilot).mockResolvedValue({ answer: "Trace summary." });
    const user = userEvent.setup();
    renderPanel(); // no spanId → trace-scoped
    await user.type(screen.getByLabelText("question"), "summarize");
    await user.click(screen.getByRole("button", { name: "Ask" }));
    await waitFor(() => expect(client.askCopilot).toHaveBeenCalledWith("t1", { question: "summarize" }));
  });
});
