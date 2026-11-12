// ESLint flat config for both workspaces (run `npm run lint` at the root, or
// `npm run lint --workspace=frontend|backend`). Syntax-level rules only (no
// type-aware linting) so it stays fast; `npm run typecheck` covers types.
import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**", "backend/uploads/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // `_`-prefixed names are intentionally unused (e.g. destructuring a field away).
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["backend/**/*.ts"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["frontend/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    plugins: { "react-hooks": reactHooks },
    rules: {
      // The two classic hooks rules. (v7's newer React Compiler rules aren't enabled: the app doesn't use the compiler.)
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  }
);
