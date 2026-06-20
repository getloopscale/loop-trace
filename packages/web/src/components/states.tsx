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
  return <div className="state-empty">{message}</div>;
}
