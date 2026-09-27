import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import virentiaStart from "@virentia/ui/start/vite";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [virentiaStart()],
  server: { host: "127.0.0.1" },
});
