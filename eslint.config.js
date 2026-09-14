import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";

export default [
  { ignores: ["dist/**", "node_modules/**", "docs/**"] },
  {
    files: ["**/*.ts"],
    languageOptions: { parser: tsparser, ecmaVersion: 2023, sourceType: "module" },
    plugins: { "@typescript-eslint": tseslint },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "no-console": "off",
      eqeqeq: ["error", "smart"],
      "prefer-const": "error",
    },
  },
];
