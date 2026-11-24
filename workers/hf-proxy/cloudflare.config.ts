import { bindings, defineConfig } from "cf/config";

// Set HF_PROXY_DOMAIN (for example hf.example.com, on a zone in your account)
// when deploying to serve the worker on that custom domain.
const domain = process.env.HF_PROXY_DOMAIN;

export default defineConfig({
	worker: {
		name: "mimivox-hf-proxy",
		compatibilityDate: "2025-09-01",
		entrypoint: "src/index.js",
		domains: domain ? [domain] : [],
		env: {
			// Comma-separated repo ids, or "*" for any public repo. Empty uses the MimiVox models.
			ALLOWED_REPOS: bindings.text(""),
			// Signs the /_cdn/ links the worker issues. Any long random string.
			CDN_SIGNING_KEY: bindings.secret(),
		},
	},
});
