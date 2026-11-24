import { OpfsBlobStore } from "./blob-store";
import { aggregateRequirements, checkCapabilities } from "./capability";
import { DEFAULT_MANIFEST } from "./manifest";
import { ModelStore } from "./model-store";
import { formatBytes, parseManifest, totalBytes, type FileRef, type FileState, type Manifest } from "./types";

function el<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (e === null) throw new Error(`#${id} missing from setup.html`);
  return e as T;
}

async function loadManifest(): Promise<Manifest> {
  const params = new URLSearchParams(location.search);
  const url = params.get("manifest");
  const base = url === null ? DEFAULT_MANIFEST : parseManifest(await (await fetch(url)).json());
  const endpoint = params.get("endpoint");
  return endpoint === null ? base : { ...base, endpoint };
}

function describe(state: FileState, size: number): string {
  switch (state.kind) {
    case "missing":
      return "not downloaded";
    case "partial":
      return `${formatBytes(state.bytes)} of ${formatBytes(size)}`;
    case "verifying":
      return "verifying...";
    case "ready":
      return "ready";
    case "failed":
      return `failed: ${state.reason}`;
  }
}

async function main(): Promise<void> {
  const manifest = await loadManifest();
  const rows = new Map<string, { li: HTMLLIElement; state: HTMLElement; bar: HTMLProgressElement; size: number }>();
  const host = el("models");
  for (const model of manifest.models) {
    const h = document.createElement("h2");
    h.textContent = `${model.label} (${formatBytes(model.files.reduce((n, f) => n + f.size, 0))})`;
    const ul = document.createElement("ul");
    for (const file of model.files) {
      const li = document.createElement("li");
      li.dataset["path"] = file.path;
      const name = document.createElement("span");
      name.textContent = `${file.path} (${formatBytes(file.size)}) `;
      const bar = document.createElement("progress");
      bar.max = file.size;
      bar.value = 0;
      const state = document.createElement("span");
      state.className = "state";
      li.append(name, bar, " ", state);
      ul.append(li);
      rows.set(`${model.id}\u0000${file.path}`, { li, state, bar, size: file.size });
    }
    host.append(h, ul);
  }

  const overall = el("overall");
  const button = el<HTMLButtonElement>("download");
  const readyMs = el("ready-ms");

  const paint = (ref: FileRef, s: FileState): void => {
    const row = rows.get(`${ref.modelId}\u0000${ref.path}`);
    if (row === undefined) return;
    row.li.dataset["state"] = s.kind;
    row.state.textContent = describe(s, row.size);
    row.bar.value = s.kind === "ready" ? row.size : s.kind === "partial" ? s.bytes : s.kind === "verifying" ? row.size : 0;
  };
  const store = new ModelStore({ manifest, store: new OpfsBlobStore(), onState: paint });

  const issues = await checkCapabilities(navigator.gpu, aggregateRequirements(manifest));
  for (const issue of issues) {
    const li = document.createElement("li");
    li.dataset["code"] = issue.code;
    li.textContent = issue.message;
    el("issues").append(li);
  }

  const finish = (): void => {
    const ready = store.allReady() && manifest.models.length > 0;
    overall.dataset["state"] = ready ? "ready" : "needs-download";
    overall.textContent = ready
      ? "All models are downloaded and verified."
      : manifest.models.length === 0
        ? "No models are configured."
        : `Models need downloading (${formatBytes(totalBytes(manifest))} total).`;
    button.disabled = ready || manifest.models.length === 0;
    el("grant").textContent = store.storageGrant;
    if (ready && readyMs.textContent === "-") readyMs.textContent = performance.now().toFixed(0);
  };

  await store.refresh();
  finish();

  button.addEventListener("click", () => {
    button.disabled = true;
    el("error").hidden = true;
    overall.dataset["state"] = "downloading";
    overall.textContent = "Downloading...";
    store.ensureAll().then(finish, (e: unknown) => {
      const err = el("error");
      err.textContent = e instanceof Error ? e.message : String(e);
      err.hidden = false;
      overall.dataset["state"] = "error";
      button.disabled = false;
    });
  });
}

void main();
