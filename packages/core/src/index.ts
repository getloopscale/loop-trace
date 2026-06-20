/**
 * @usetheo/lens-core barrel — domain types, repository port, and Drizzle adapter.
 */
export { type Span, spanSchema } from "./domain/span.js";
export { type SpanRepository, type TraceTreeNode } from "./domain/span-repository.js";
export { extractGenAi, type GenAiFields } from "./domain/genai-attributes.js";
export { spans, traces, sessions } from "./infrastructure/db/schema.js";
export {
  DrizzleSpanRepository,
  createPool,
  createSpanRepository,
  migrateLatest,
} from "./infrastructure/db/drizzle-span-repository.js";
