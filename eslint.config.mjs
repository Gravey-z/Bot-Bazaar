import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

import publicImports from "./scripts/public-imports-rule.mjs";
import publicText from "./scripts/public-text-rule.mjs";

export default defineConfig([
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "**/.angular/**",
      "target/**",
    ],
  },
  {
    files: ["**/*.{js,mjs}"],
    extends: [js.configs.recommended],
    languageOptions: { globals: globals.node },
  },
  {
  files: ["apps/**/*.ts", "packages/**/*.ts"],
  extends: [js.configs.recommended, tseslint.configs.recommended],
  rules: { "@typescript-eslint/explicit-module-boundary-types": "off" },
},
  {
    files: ["apps/worker/src/**/*.ts"],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["apps/web/src/**/*.{ts,tsx,js,mjs}"],
    plugins: { rendering: { rules: { "public-text": publicText } } },
    rules: { "rendering/public-text": "error" },
  },
  {
    files: [
      "apps/web/src/**/*.{ts,tsx,js,mjs}",
      "packages/shared/src/**/*.{ts,tsx,js,mjs}",
      "packages/chain/src/**/*.{ts,tsx,js,mjs}",
    ],
    languageOptions: { parser: tseslint.parser, globals: globals.browser },
    linterOptions: { noInlineConfig: true },
    plugins: { architecture: { rules: { "public-imports": publicImports } } },
    rules: {
      "architecture/public-imports": "error",
      "no-restricted-globals": [
        "error",
        "process",
        "Buffer",
        "require",
        "module",
        "global",
      ],
      "no-restricted-properties": [
        "error",
        { object: "globalThis", property: "process" },
        { object: "globalThis", property: "Buffer" },
      ],
    },
  },
]);
