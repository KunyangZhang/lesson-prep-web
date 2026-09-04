import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ["react", "react-dom"],
          markdown: ["react-markdown", "remark-gfm", "remark-math", "rehype-katex", "rehype-sanitize"],
          icons: ["lucide-react"]
        }
      }
    }
  },
  server: {
    middlewareMode: false
  }
});
