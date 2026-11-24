# Hugging Face download proxy (Cloudflare Worker)

An anonymous, read-only proxy for people who cannot reach huggingface.co but can reach Cloudflare. Deploy it, then enter its address as the Download Source in MimiVox (Settings > Models > Download Source). See [docs/model-mirror.md](../../docs/model-mirror.md) for the other ways to set it.

It stores nothing. Each request streams from Hugging Face through the worker.

## Deploy

```bash
cd workers/hf-proxy
npm install
npx wrangler login
npx wrangler deploy
```

Wrangler prints the address, such as `https://mimivox-hf-proxy.<account>.workers.dev`. Use that as the Download Source.

## What it serves

| Path | Purpose |
| --- | --- |
| `/api/models/<repo>[/revision/<rev>]` | Repo metadata for `snapshot_download` and model sizes |
| `/<repo>/resolve/<rev>/<file>` | File downloads |
| `/api/resolve-cache/models/<repo>/...` | Where the Hub redirects small files |
| `/_cdn/<host>/...` | Large files. The Hub redirects them to signed CDN URLs, and the worker rewrites those redirects to this route |

Only GET and HEAD are allowed. The worker never forwards Authorization or cookies, so it serves public repos only.

It removes the Xet headers from Hub replies. huggingface_hub then downloads with plain HTTP through the worker instead of contacting the Xet storage service directly.

## Which repos it serves

By default, only the models MimiVox downloads. To change that, set `ALLOWED_REPOS` in `wrangler.toml` or the Cloudflare dashboard to comma-separated repo ids, or to `*` for any public repo. Leaving it as `*` turns the worker into an open Hugging Face proxy on your account.

## Run it locally

```bash
npm run dev
HF_ENDPOINT=http://localhost:8787 python -c 'from huggingface_hub import snapshot_download; print(snapshot_download("Wespeaker/wespeaker-voxceleb-resnet34-LM"))'
```
