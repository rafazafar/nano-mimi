# Hugging Face download proxy (Cloudflare Worker)

An anonymous, read-only proxy for people who cannot reach huggingface.co but can reach Cloudflare. Deploy it, then enter its address as the Download Source in MimiVox (Settings > Models > Download Source). See [docs/model-mirror.md](../../docs/model-mirror.md) for the other ways to set it.

By default each request streams from Hugging Face through the worker. Files pinned to a commit sha can also be served from an R2 bucket, so downloads keep working while Hugging Face is down (see [R2 mirror](#r2-mirror)).

## Deploy

It deploys with the [`cf` CLI](https://developers.cloudflare.com/) from `cloudflare.config.ts`.

```bash
cd workers/hf-proxy
npm install
npx cf auth login
printf 'CDN_SIGNING_KEY=%s\n' "$(openssl rand -hex 32)" > /tmp/hf-proxy.secrets.env
HF_PROXY_DOMAIN=hf.example.com npx cf deploy --secrets-file /tmp/hf-proxy.secrets.env
rm /tmp/hf-proxy.secrets.env
```

- `CDN_SIGNING_KEY` signs the `/_cdn/` links the worker issues (see below). Any long random string works. Upload it on the first deploy only; later deploys keep it. Without it, the worker answers every request with 500.
- `HF_PROXY_DOMAIN` is a hostname on a zone in your Cloudflare account. The deploy creates its DNS record and certificate. Leave it unset to use the `workers.dev` address only.
- If your login has several accounts, set `CLOUDFLARE_ACCOUNT_ID`.

Use `https://<HF_PROXY_DOMAIN>` as the Download Source.

## What it serves

| Path | Purpose |
| --- | --- |
| `/api/models/<repo>[/revision/<rev>]` | Repo metadata for `snapshot_download` and model sizes |
| `/<repo>/resolve/<rev>/<file>` | File downloads |
| `/api/resolve-cache/models/<repo>/...` | Where the Hub redirects small files |
| `/_cdn/<sig>/<host>/...` | Large files. The Hub redirects them to signed CDN URLs, and the worker rewrites those redirects to this route |

`<sig>` is an HMAC of the CDN URL under `CDN_SIGNING_KEY`. The worker serves `/_cdn/` only for links it issued itself, after checking the repo. A storage URL that someone fetched from the Hub for another repo is refused with 403.

Only GET and HEAD (and CORS preflight) are allowed. The worker never forwards Authorization or cookies, so it serves public repos only.

It removes the Xet headers from Hub replies. huggingface_hub then downloads with plain HTTP through the worker instead of contacting the Xet storage service directly.

Browsers can use it too. Every reply allows any origin and carries `Cross-Origin-Resource-Policy: cross-origin`, so a cross-origin-isolated page (COOP/COEP) can fetch from it. For transformers.js, set `env.remoteHost` to the worker's address.

## R2 mirror

For `/<repo>/resolve/<rev>/<file>` where `<rev>` is a 40-hex commit sha, the worker first looks for the object `<repo>/<rev>/<file>` in the `MODELS` R2 bucket (`mimivox-models`). A hit is served from R2 with Range (206 and `Content-Range`), HEAD, `ETag` and `Accept-Ranges`. A miss falls through to the Hub. Branch and tag revisions such as `main` are mutable and never use R2. The repo allowlist is checked first.

Every reply carries `x-mimivox-source: r2` or `hub`, so you can see where it came from.

Create the bucket once, before the first deploy:

```bash
npx cf r2 buckets create-by-name mimivox-models
```

### Seeding it

`scripts/seed_model_mirror.mjs` copies the web app's pinned files into the bucket. The model list comes from the web app, not from a second copy: it imports `src/models/manifest.ts` and `src/asr/models.ts` from the web directory.

```bash
export CLOUDFLARE_ACCOUNT_ID=<account>
node scripts/seed_model_mirror.mjs --web web   # --dry-run lists the files only
```

For each file whose revision is a commit sha, it skips the file if R2 already holds an object of the manifest size. Otherwise it downloads the file from huggingface.co, checks the size and sha256 against the manifest, and uploads it. Files over 32 MiB go up as multipart. A mismatch aborts that file and the run exits 1. Rerun it after the manifest changes.

Uploads go through a throwaway worker (`mimivox-model-seed`, the `SEED_UPLOADER=1` mode of `cloudflare.config.ts`) that holds the R2 binding. The script deploys it with a random one-off token and deletes it when done, so no R2 API credentials are created. It needs only your `cf auth login` session.

## Which repos it serves

By default, only the models MimiVox downloads. To change that, set `ALLOWED_REPOS` in `cloudflare.config.ts` to comma-separated repo ids, or to `*` for any public repo. Leaving it as `*` turns the worker into an open Hugging Face proxy on your account.

## Run it locally

```bash
printf 'CDN_SIGNING_KEY=%s\n' "$(openssl rand -hex 32)" > .dev.vars
npm run dev
HF_ENDPOINT=http://localhost:8787 python -c 'from huggingface_hub import snapshot_download; print(snapshot_download("Wespeaker/wespeaker-voxceleb-resnet34-LM"))'
```
