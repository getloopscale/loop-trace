import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Dialog } from "@theokit/ui";

interface Command {
  id: string;
  label: string;
  /** Navigate target, or "trace-by-id" to switch the palette into id-entry mode. */
  path?: string;
  action?: "trace-by-id";
}

/** Static command set — every view is reachable, plus an open-trace-by-id action. */
const COMMANDS: Command[] = [
  { id: "executions", label: "Go to Executions", path: "/" },
  { id: "sessions", label: "Go to Sessions", path: "/sessions" },
  { id: "dashboards", label: "Go to Dashboards", path: "/dashboards" },
  { id: "tools", label: "Go to Tools", path: "/tools" },
  { id: "cost", label: "Go to Cost analytics", path: "/analytics" },
  { id: "agent-graph", label: "Go to Agent Graph", path: "/agent-graph" },
  { id: "agent-path", label: "Go to Agent Path", path: "/agent-path" },
  { id: "trace-by-id", label: "Open trace by ID…", action: "trace-by-id" },
];

/**
 * Cmd/Ctrl+K command palette (M-UX). A controlled `@theokit/ui` Dialog (Radix —
 * focus trap, Esc-to-close, and focus-return are handled by the primitive) hosting
 * a fuzzy-filtered command list. The global key listener only fires on the
 * Cmd/Ctrl+K chord, so it never hijacks normal typing. "Open trace by ID" switches
 * the palette into an id-entry mode that navigates to /traces/:id.
 */
export function CommandPalette() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const [mode, setMode] = useState<"commands" | "trace-id">("commands");
  const [traceId, setTraceId] = useState("");
  const idInputRef = useRef<HTMLInputElement>(null);

  // Global Cmd/Ctrl+K toggle. Modifier required → never interferes with typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Reset transient state whenever the palette opens.
  useEffect(() => {
    if (open) {
      setQuery("");
      setHighlight(0);
      setMode("commands");
      setTraceId("");
    }
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q === ""
      ? COMMANDS
      : COMMANDS.filter((c) => c.label.toLowerCase().includes(q));
  }, [query]);

  // The id of the active option — wires the combobox input to the highlighted
  // option (APG combobox+listbox: aria-activedescendant) so screen readers
  // announce the active command during arrow navigation (review F-fe-1).
  const activeOption = filtered[highlight];
  const activeOptionId = activeOption ? `cmdk-opt-${activeOption.id}` : undefined;

  // Keep the highlighted option scrolled into the (max-h, scrollable) list
  // as arrow keys move past the fold (review F-fe-2).
  useEffect(() => {
    if (mode !== "commands" || activeOptionId == null) return;
    // optional-call the method: jsdom elements lack scrollIntoView (mirrors SpanTree).
    document.getElementById(activeOptionId)?.scrollIntoView?.({ block: "nearest" });
  }, [activeOptionId, mode]);

  function runCommand(cmd: Command | undefined): void {
    if (cmd == null) return;
    if (cmd.action === "trace-by-id") {
      setMode("trace-id");
      // focus the id input after it mounts
      queueMicrotask(() => idInputRef.current?.focus());
      return;
    }
    if (cmd.path != null) {
      navigate(cmd.path);
      setOpen(false);
    }
  }

  function onListKeyDown(e: React.KeyboardEvent): void {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHighlight((h) => Math.min(filtered.length - 1, h + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      runCommand(filtered[highlight]);
    }
  }

  function onTraceIdKeyDown(e: React.KeyboardEvent): void {
    if (e.key === "Enter") {
      e.preventDefault();
      const id = traceId.trim();
      if (id.length === 0) return;
      navigate(`/traces/${encodeURIComponent(id)}`);
      setOpen(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Dialog.Content aria-label="Command palette" className="max-w-lg">
        <Dialog.Title className="sr-only">Command palette</Dialog.Title>
        <Dialog.Description className="sr-only">
          Search commands or open a trace by ID. Use arrow keys and Enter.
        </Dialog.Description>
        {mode === "commands" ? (
          <div className="flex flex-col gap-2">
            <input
              type="text"
              role="combobox"
              aria-label="command search"
              aria-expanded="true"
              aria-controls="cmdk-listbox"
              aria-activedescendant={activeOptionId}
              placeholder="Type a command…"
              value={query}
              autoFocus
              onChange={(e) => {
                setQuery(e.target.value);
                setHighlight(0);
              }}
              onKeyDown={onListKeyDown}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
            />
            <ul
              id="cmdk-listbox"
              className="m-0 flex max-h-72 list-none flex-col gap-0.5 overflow-auto p-0"
              role="listbox"
              aria-label="commands"
            >
              {filtered.length === 0 ? (
                <li className="px-3 py-2 text-sm text-muted-foreground">
                  No matching command
                </li>
              ) : (
                filtered.map((c, i) => (
                  <li
                    key={c.id}
                    id={`cmdk-opt-${c.id}`}
                    role="option"
                    aria-selected={i === highlight}
                  >
                    <button
                      type="button"
                      tabIndex={-1}
                      className={`w-full rounded px-3 py-2 text-left text-sm transition-colors hover:bg-muted ${
                        i === highlight ? "bg-muted" : ""
                      }`}
                      onClick={() => runCommand(c)}
                      onMouseEnter={() => setHighlight(i)}
                    >
                      {c.label}
                    </button>
                  </li>
                ))
              )}
            </ul>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <input
              ref={idInputRef}
              type="text"
              aria-label="trace id"
              placeholder="Enter trace ID, then Enter…"
              value={traceId}
              onChange={(e) => setTraceId(e.target.value)}
              onKeyDown={onTraceIdKeyDown}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
            />
          </div>
        )}
      </Dialog.Content>
    </Dialog>
  );
}
