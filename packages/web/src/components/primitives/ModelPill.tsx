/**
 * ModelPill (M29) — a neutral chip showing a model id with a leading colour dot.
 * The dot colour is a DETERMINISTIC hash of the model string into the Violet-Forge
 * token palette (no raw hex, no Date/random), so the same model always reads the
 * same colour — the cheap, faithful equivalent of the peer "coloured model pill".
 * An absent/empty model renders an em-dash, never a blank pill (EC-1).
 */

/** Token text classes the dot can take — same palette family as kind colours. */
const PALETTE = [
  "text-primary",
  "text-accent",
  "text-warning",
  "text-info",
  "text-success",
] as const;

/** Stable 32-bit string hash (deterministic — no Date/random). */
function hashModel(model: string): number {
  let h = 0;
  for (let i = 0; i < model.length; i++) {
    h = (h * 31 + model.charCodeAt(i)) >>> 0;
  }
  return h;
}

/** The deterministic dot colour class for a model id (exported for tests). */
export function modelDotClass(model: string): string {
  return PALETTE[hashModel(model) % PALETTE.length]!;
}

export function ModelPill({ model }: { model?: string | undefined }) {
  if (model == null || model.length === 0) {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2 py-0.5 text-xs text-foreground">
      <span className={modelDotClass(model)} aria-hidden="true">
        ●
      </span>
      {model}
    </span>
  );
}
