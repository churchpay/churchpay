import js from "@eslint/js";
import next from "@next/eslint-plugin-next";
import hooks from "eslint-plugin-react-hooks";
import globals from "globals";
import ts from "typescript-eslint";
import prettier from "eslint-config-prettier/flat";

export default [
  js.configs.recommended,
  ...ts.configs.recommended,
  hooks.configs.flat.recommended,
  { languageOptions: { globals: { ...globals.browser, ...globals.node } } },
  {
    files: ["**/*.{ts,tsx}"],
    plugins: { "@next/next": next },
    rules: {
      ...next.configs.recommended.rules,
      ...next.configs["core-web-vitals"].rules,
    },
  },
  prettier,
  { ignores: [".next/**", "node_modules/**", "next-env.d.ts"] },
];
