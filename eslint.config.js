import js from "@eslint/js";
import globals from "globals";
import markdown from "@eslint/markdown";
import css from "@eslint/css";
import { defineConfig } from "eslint/config";

export default defineConfig([
  // Ignore generated files in app/lib and vendor directories, plus the
  // Tailwind v4 source (its @theme/@source/@custom-variant at-rules aren't
  // parseable standard CSS; the Tailwind compiler validates it on build).
  { ignores: ["app/lib/**", "vendor/**", "app/vendor/**", "coverage/**", "tailwind.source.css"] },
  {
    files: ["**/*.{js,mjs,cjs}"],
    plugins: { js },
    extends: ["js/recommended"],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      // Allow unused variables if they start with underscore
      'no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ]
    }
  },
  { files: ["**/*.md"], plugins: { markdown }, language: "markdown/gfm", extends: ["markdown/recommended"] },
  { files: ["**/*.css"], plugins: { css }, language: "css/css", extends: ["css/recommended"] },
]);
