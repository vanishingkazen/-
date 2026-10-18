import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import path from "path"

export default defineConfig({
  plugins: [react()],
  base: "/",
  build: {
    outDir: "dist/mobile",
    emptyOutDir: false,
    sourcemap: false,
    rollupOptions: {
      input: path.resolve(__dirname, "companion.html")
    }
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src")
    }
  }
})
