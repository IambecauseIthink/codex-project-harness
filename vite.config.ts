import { defineConfig } from "vite";
export default defineConfig({
  root: "src/ui",
  build: { outDir: "../../dist/ui", emptyOutDir: true },
});
