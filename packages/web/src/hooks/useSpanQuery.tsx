import { createContext, useContext, useState, type ReactNode } from "react";

/**
 * Global span-query (M30b) — the single span-filter spine shared by every project-view
 * tab (Traces, Agent Graph, Agent Path). M30 shipped a page-local bar in TraceListPage;
 * M30b lifts the query here so one toolbar drives all tabs. Mirrors `useRange` /
 * `useAutoRefresh`: a context + defensive localStorage so a disabled/private/corrupt
 * store falls back to "" (no filter) and never crashes boot. The string is the M30 DSL
 * (`kind:llm status:error model:gpt-4o name:"…"`), parsed server-side by `parseSpanQuery`.
 */
const STORAGE_KEY = "looptrace.spanQuery";

/** Read the persisted span-query; "" on any failure (disabled/missing store). */
export function readStoredSpanQuery(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function writeStoredSpanQuery(value: string): void {
  try {
    if (value) localStorage.setItem(STORAGE_KEY, value);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* storage disabled / quota — in-memory state still holds */
  }
}

interface SpanQueryContextValue {
  spanQuery: string;
  setSpanQuery: (value: string) => void;
}

const SpanQueryContext = createContext<SpanQueryContextValue>({
  spanQuery: "",
  setSpanQuery: () => {},
});

export function SpanQueryProvider({ children }: { children: ReactNode }) {
  const [spanQuery, setState] = useState<string>(readStoredSpanQuery);
  function setSpanQuery(value: string): void {
    setState(value);
    writeStoredSpanQuery(value);
  }
  return (
    <SpanQueryContext.Provider value={{ spanQuery, setSpanQuery }}>
      {children}
    </SpanQueryContext.Provider>
  );
}

/** Read + set the shared global span-query. */
export function useSpanQuery(): SpanQueryContextValue {
  return useContext(SpanQueryContext);
}
