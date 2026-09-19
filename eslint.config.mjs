// Type-checked lint for the TypeScript SDK; plain recommended rules for scripts.
// The promise rules protect the fail-open contract in RELIABILITY.md: a dangling
// rejection in telemetry code must never terminate an application process.
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

const sdkFiles = ["packages/sdk-typescript/src/**/*.ts", "packages/sdk-typescript/tests/**/*.ts"];

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.venv/**",
      "examples/reference-chatbot/**",
      "eslint.config.mjs",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({ ...config, files: sdkFiles })),
  {
    files: sdkFiles,
    languageOptions: {
      parserOptions: {
        project: "./packages/sdk-typescript/tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
      globals: globals.node,
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": [
        "error",
        { checksVoidReturn: { attributes: false, arguments: false } },
      ],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/no-base-to-string": "off",
      "@typescript-eslint/no-redundant-type-constituents": "off",
    },
  },
  {
    // Test files use bun:test idioms that the typed promise rules misread: `expect().rejects`
    // is not typed as a thenable, `server.stop()` promises are intentionally left dangling in
    // teardown, and HueSpan methods are closures destructured from the handle.
    files: ["packages/sdk-typescript/tests/**/*.ts"],
    rules: {
      "@typescript-eslint/await-thenable": "off",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/unbound-method": "off",
    },
  },
  {
    files: [
      "packages/sdk-typescript/src/**/*.mjs",
      "packages/sdk-typescript/scripts/**/*.mjs",
      "scripts/**/*.mjs",
    ],
    languageOptions: { globals: globals.node },
    rules: {
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
);
