/**
 * Placeholder for Arize project-view tabs whose dedicated view ships in a later
 * UX-track milestone (Spans → M18, Agent Graph / Agent Path → M21). Keeps the
 * information architecture complete and the tab bar honest.
 */
export function PlaceholderPage({
  title,
  milestone,
}: {
  title: string;
  milestone: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-24 text-center">
      <h2 className="text-title-lg font-display text-foreground">{title}</h2>
      <p className="text-body-sm text-muted-foreground">
        Coming in {milestone}.
      </p>
    </div>
  );
}
