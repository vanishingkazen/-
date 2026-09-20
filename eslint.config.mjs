import js from "@eslint/js";
import globals from "globals";
import tseslintPlugin from "@typescript-eslint/eslint-plugin";
import tseslintParser from "@typescript-eslint/parser";

export default [
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "dist-electron/**",
      "release/**",
      "package-lock.json",
      "bun.lockb",
      "**/*.json",
      "**/*.jsonc",
      "**/*.json5",
      "**/*.md",
      "**/*.css",
    ],
  },

  {
    files: ["**/*.{js,mjs,cjs,ts,tsx}"],
    languageOptions: {
      parser: tseslintParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    plugins: {
      "@typescript-eslint": tseslintPlugin,
    },
    rules: {
      ...js.configs.recommended.rules,
      ...tseslintPlugin.configs.recommended.rules,
    },
  },

  {
    files: ["**/*.cjs", "native/**/*.js", "debug-window-size.js"],
    rules: {
      "@typescript-eslint/no-var-requires": "off",
    },
  },
];
