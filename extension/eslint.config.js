import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";



const SINKS = {
  "no-eval": "error",
  "no-implied-eval": "error",
  "no-new-func": "error",
  "no-script-url": "error",
  "no-restricted-properties": [
    "error",
    ...["innerHTML", "outerHTML", "insertAdjacentHTML", "srcdoc"].map((property) => ({
      property,
      message: "Build DOM with Preact or createElement, never from HTML strings.",
    })),
    { object: "document", property: "write", message: "No document.write." },
    { object: "document", property: "writeln", message: "No document.writeln." },
  ],
  "no-restricted-syntax": [
    "error",
    {
      selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
      message: "No raw HTML in the extension's pages.",
    },
    {
      selector: "CallExpression[callee.name=/^set(Timeout|Interval)$/][arguments.0.type='Literal']",
      message: "No string timers.",
    },
    {
      selector: "Identifier[name='onMessageExternal']",
      message: "The extension accepts no messages from outside itself.",
    },
  ],
};

export default tseslint.config(
  {
    ignores: [
            "dist/**",
      "dist-dev/**",
      "node_modules/**",
                ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx,js,mjs}"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.browser, ...globals.webextensions, ...globals.node },
    },
    rules: {
      ...SINKS,
      "no-empty": ["error", { allowEmptyCatch: true }],
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  }
);
