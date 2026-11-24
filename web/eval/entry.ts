// The real app, mounted exactly as src/ui/main.ts mounts it, with one addition: every session's pipeline events
// are also fed to a RowLog that run.ts reads after the session ends. Nothing about the pipeline changes.
import "../src/ui/styles/index.css";
import { mountApp } from "../src/ui/app";
import { realDeps } from "../src/ui/realDeps";
import { RowLog, type SessionRecord } from "./rowLog";

declare global {
  interface Window {
    /** The rows of the latest session, in the Python log's shape. */
    __mimivoxEval?: { snapshot(): SessionRecord };
  }
}

const root = document.getElementById("app");
if (root === null) throw new Error("#app missing from index.html");

let log = new RowLog();
const deps = realDeps();
mountApp(root, {
  ...deps,
  startSession: (options) => {
    log = new RowLog();
    return deps.startSession({
      ...options,
      onEvent: (event) => {
        log.apply(event);
        options.onEvent(event);
      },
    });
  },
});
window.__mimivoxEval = { snapshot: () => log.snapshot() };
