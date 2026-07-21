// ESLint 9 flat config — TypeScript across packages; React-hooks rules for the web UI.
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

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
      // The `_`-prefix convention for a deliberately-unused binding is already
      // used throughout this codebase (`_id`, `_spans`, `_m`, `_url`, `_n`, …).
      // It passed only by accident: the default `args: "after-used"` skips
      // leading parameters, but nothing exempted destructured VARIABLES, so the
      // canonical omit idiom (`const { k: _k, ...rest } = obj`) errored while
      // every `_`-prefixed parameter did not. Stating the convention makes it
      // hold uniformly. `ignoreRestSiblings` exists for exactly that idiom.
      // This exempts only bindings explicitly marked unused — a genuinely
      // unused variable without the prefix still errors.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true,
        },
      ],
    },
  },
  {
    // React-hooks correctness rules, scoped to the web UI (T1.1 / ADR D3).
    files: ["packages/web/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
);
