/**
 * GenAI span attribute names the SDK emits. These MUST match exactly the names
 * the M1 ingestion reads (`@usetheo/lens-core` extractGenAi) so the typed
 * columns (model/provider/tokens) populate — see m1-contract test (EC-2).
 */
export const GEN_AI = {
  REQUEST_MODEL: "gen_ai.request.model",
  RESPONSE_MODEL: "gen_ai.response.model",
  SYSTEM: "gen_ai.system",
  USAGE_INPUT_TOKENS: "gen_ai.usage.input_tokens",
  USAGE_OUTPUT_TOKENS: "gen_ai.usage.output_tokens",
  OPERATION_NAME: "gen_ai.operation.name",
  TOOL_NAME: "gen_ai.tool.name",
  TOOL_ARGUMENTS: "gen_ai.tool.arguments",
  // M12: span input/output text. OpenInference generic keys (an established
  // convention), NOT the deprecated gen_ai.prompt/completion. Read back into typed
  // columns by extractGenAi (capped at ingest — see M12 ADR D2/D5).
  INPUT_VALUE: "input.value",
  OUTPUT_VALUE: "output.value",
} as const;
