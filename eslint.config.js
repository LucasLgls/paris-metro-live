import eslint from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/coverage/**", "**/playwright-report/**", "**/test-results/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname
      },
      globals: {
        ...globals.browser,
        ...globals.node
      }
    },
    rules: {
      "@typescript-eslint/consistent-type-definitions": ["error", "type"],
      "@typescript-eslint/no-confusing-void-expression": "off",
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: false }]
    }
  },
  {
    files: ["**/*.config.{js,mjs,ts}", "eslint.config.js"],
    ...tseslint.configs.disableTypeChecked
  },
  {
    files: ["apps/web/src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@paris-transit/transit-core",
              message:
                "The browser may import only @paris-transit/transit-core/display, the shared position code."
            }
          ],
          patterns: [
            {
              group: ["**/apps/server/**"],
              message: "Server modules cannot be imported into the browser."
            }
          ]
        }
      ]
    }
  },
  {
    files: ["packages/transit-core/src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["node:*", "**/apps/**", "**/network-build/**"],
              message: "Transit core must remain independent of runtimes and infrastructure."
            }
          ]
        }
      ]
    }
  }
);
