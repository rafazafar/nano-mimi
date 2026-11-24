import { bindings, defineConfig } from "cf/config";

// Set HF_PROXY_DOMAIN (for example hf.example.com, on a zone in your account)
// when deploying to serve the worker on that custom domain.
const domain = process.env.HF_PROXY_DOMAIN;

const R2 = bindings.r2({ name: "mimivox-models" });

// scripts/seed_model_mirror.mjs sets SEED_UPLOADER=1 to deploy a throwaway
// upload endpoint with the same R2 binding (multipart uploads without R2 API
// credentials), and deletes it afterwards.
const seedUploader = process.env.SEED_UPLOADER === "1";

export default defineConfig({
	worker: seedUploader
		? {
				name: "mimivox-model-seed",
				compatibilityDate: "2025-09-01",
				entrypoint: "src/seed-uploader.js",
				env: {
					// Random per run; the seed script generates it.
					UPLOAD_TOKEN: bindings.secret(),
					MODELS: R2,
				},
			}
		: {
				name: "mimivox-hf-proxy",
				compatibilityDate: "2025-09-01",
				entrypoint: "src/index.js",
				domains: domain ? [domain] : [],
				env: {
					// Comma-separated repo ids, or "*" for any public repo. Empty uses the MimiVox models.
					ALLOWED_REPOS: bindings.text(""),
					// Signs the /_cdn/ links the worker issues. Any long random string.
					CDN_SIGNING_KEY: bindings.secret(),
					// Pinned model files copied from the Hub (scripts/seed_model_mirror.mjs).
					MODELS: R2,
				},
			},
});
