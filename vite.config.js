import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import path from "node:path";
import { copyPublicPackage } from "./scripts/copy-public-package.mjs";

let resolvedConfig;

export default defineConfig({
  base: process.env.REVIEW_BASE_PATH || "/lead-gen-review-app/",
  resolve: {
    alias: {
      vue: "vue/dist/vue.esm-bundler.js",
    },
  },
  build: { copyPublicDir: false },
  // Research is refreshed by its snapshot poll; thousands of immutable files
  // must not trigger development-server reloads during publication.
  server: { watch: { ignored: ["**/public/data/**", "**/dist/**"] } },
  plugins: [vue(), {
    name: "current-review-package",
    apply: "build",
    configResolved(config) { resolvedConfig = config; },
    async closeBundle() {
      await copyPublicPackage(resolvedConfig.publicDir, path.resolve(resolvedConfig.root, resolvedConfig.build.outDir));
    },
  }],
});
