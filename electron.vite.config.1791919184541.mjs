// electron.vite.config.ts
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";
import { resolve } from "path";
import { readFileSync } from "fs";
var __electron_vite_injected_dirname = "C:\\Users\\kajtg\\Documents\\Projekt domy\u015Blny\\codezy";
var pkg = JSON.parse(readFileSync(resolve(__electron_vite_injected_dirname, "package.json"), "utf8"));
var electron_vite_config_default = defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        "@": resolve(__electron_vite_injected_dirname, "src/renderer/src")
      }
    },
    // version shown in the title bar + Settings → about
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version)
    },
    plugins: [react()]
  }
});
export {
  electron_vite_config_default as default
};
