import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  build: {
    target: "node22",
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    minify: false,
    lib: {
      entry: resolve(import.meta.dirname, "src/index.ts"),
      formats: ["es", "cjs"],
      fileName: (format) => (format == "es" ? "index.js" : "index.cjs"),
    },
    rolldownOptions: { external: [/^node:/, /^@duraxis\//] },
  },
});
