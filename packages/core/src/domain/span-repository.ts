import type { Span } from "./span.js";

/**
 * Persistence port for spans (DIP). The domain declares the contract; the
 * infrastructure layer (Drizzle/Postgres) implements it. M0 needs only the two
 * operations exercised by the walking skeleton: bulk save and read-one.
 */
export interface SpanRepository {
  /** Persist a batch of spans. Idempotent on spanId; empty batch is a no-op. */
  save(spans: Span[]): Promise<void>;
  /** Read a single span by its spanId, or null if absent. */
  getBySpanId(spanId: string): Promise<Span | null>;
}
