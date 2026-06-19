/**
 * @usetheo/lens-core barrel — domain types, repository port, and Drizzle adapter.
 */
export { type Span, spanSchema } from "./domain/span.js";
export { type SpanRepository } from "./domain/span-repository.js";
export {
  DrizzleSpanRepository,
  createPool,
} from "./infrastructure/db/drizzle-span-repository.js";
export { spans } from "./infrastructure/db/schema.js";
