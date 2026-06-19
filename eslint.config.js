// ESLint 9 flat config — TypeScript only, minimal for M0 walking skeleton.
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "knowledge-base/**",
      "**/migrations/**",
      "**/*.config.ts",
      "**/*.config.js",
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
);
