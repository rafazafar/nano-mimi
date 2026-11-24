import "./styles/index.css";
import { mountApp } from "./app";
import { ALL_ASR_MODELS } from "../asr/models";
import { OpfsBlobStore, pruneUnknownModels } from "../models";
import { CAT_MODEL } from "../models/manifest";
import { realDeps } from "./realDeps";

const root = document.getElementById("app");
if (root === null) throw new Error("#app missing from index.html");
mountApp(root, realDeps());
// Every model any pair or backend can use; anything else on disk is left over from an older release.
void pruneUnknownModels(new OpfsBlobStore(), [...ALL_ASR_MODELS, CAT_MODEL].map((m) => m.id)).catch((e: unknown) =>
  console.warn("could not remove old models", e),
);
