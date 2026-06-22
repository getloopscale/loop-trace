/** Async-state primitives shared by every data view (loading / error / empty). */

export function Loading({ label = "Loading…" }: { label?: string }) {
  return (
    <div role="status" aria-busy="true" className="state-loading">
      {label}
    </div>
  );
}

export function ErrorState({ message }: { message: string }) {
  return (
    <div role="alert" className="state-error">
      {message}
    </div>
  );
}

export function EmptyState({ message }: { message: string }) {
  // NOTE (review F-fe-3, deferred): a role=status here would announce an empty
  // result reached after load — but EmptyState is shared (SpanDetail empty
  // fields, cost/tool/north-star views), and a second live region collides with
  // ReplayControls' own role=status. Deferred rather than destabilize M3-M6 a11y
  // for a LOW nicety; revisit with a dedicated announce strategy.
  return <div className="state-empty">{message}</div>;
}
