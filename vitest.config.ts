import { defineConfig } from "vitest/config";
import { resolve } from "path";

/**
 * Vitest configuration for unit tests. Kept separate from `vite.config.ts`
 * so the dev/build configuration (which is `async` and tailored for Tauri)
 * stays focused on the application bundle. Playwright end-to-end specs in
 * `tests/` are intentionally excluded from Vitest's discovery.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
      "@/bindings": resolve(__dirname, "./src/bindings.ts"),
    },
  },
  test: {
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    exclude: ["node_modules/**", "dist/**", "tests/**", "src-tauri/**"],
    environment: "node",
  },
});
