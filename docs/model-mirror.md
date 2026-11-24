# Downloading models from a mirror

MimiVox downloads its models from huggingface.co by default. An organization can point the downloads at an internal Hugging Face mirror instead, such as an Artifactory or Nexus "Hugging Face" remote repository. Every download goes through `huggingface_hub`, so the mirror needs to serve the standard `/<repo>/resolve/<revision>/<file>` paths.

The models MimiVox fetches are:

- `LibraxisAI/whisper-large-v3-turbo-mlx-q8`
- `basyauma-tech/Haas-ja-v1.0-mlx-8bit`
- `hotchpotch/CAT-Translate-1.4b-mlx-q4`
- `mlx-community/Qwen3-4B-Instruct-2507-4bit` (meeting notes, optional)
- `Wespeaker/wespeaker-voxceleb-resnet34-LM` (speaker labels, optional)

## Where the address comes from

The first of these that is set wins:

1. **Managed preference (MDM).** Key `ModelDownloadEndpoint` in the `local.mimivox.app` domain. The Settings field shows it read-only.
2. **Settings > Models > Download Source.** What the user typed.
3. **Build default.** Run `MIMIVOX_MODEL_ENDPOINT=https://mirror.example.com/api/huggingface scripts/build_app.sh`. This stores the address in the app's Info.plist as `MIMIVOXModelEndpoint`.
4. huggingface.co.

The app passes the address to its helper as `HF_ENDPOINT` when the helper starts, and Apply restarts the helper.

## Access tokens

To use an authenticated mirror, enter its token under Settings > Models > Download Source. The macOS app stores the token in the login Keychain under service "MimiVox model download token". It binds the token to the mirror's HTTPS origin. It sends the token only to that origin. It never sends the token to huggingface.co. HTTP mirrors work without a token. The helper ignores tokens from the shell environment and local Hugging Face login.

If you saved a mirror token in an earlier release, enter it again after you upgrade.
MimiVox needs this step to bind the token to the mirror's HTTPS origin.

Hugging Face Hub follows model download redirects. Its pinned HTTPX client removes the Authorization header when an HTTPS redirect changes origin. The Settings check follows a credentialed redirect only when it stays on the same HTTPS origin.

## Configuration profile

```xml
<dict>
  <key>PayloadType</key>
  <string>local.mimivox.app</string>
  <key>PayloadIdentifier</key>
  <string>com.example.mimivox.model-mirror</string>
  <key>PayloadUUID</key>
  <string>REPLACE-WITH-A-UUID</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
  <key>ModelDownloadEndpoint</key>
  <string>https://mirror.example.com/api/huggingface</string>
</dict>
```

Place this dict in the `PayloadContent` array of a profile, or enter the same key in your MDM's custom settings for the `local.mimivox.app` domain.

To try it without MDM, run `defaults write local.mimivox.app ModelDownloadEndpoint https://mirror.example.com`. A value set this way acts like the user's own setting and is not locked.

Use **Test** in Settings to check the address. It asks the mirror for the translation model's `config.json`, which is the first file a real download fetches.

## Cloudflare Worker proxy

If you cannot reach huggingface.co but can reach Cloudflare, deploy the anonymous proxy in [`workers/hf-proxy`](../workers/hf-proxy/README.md) and use its address as the download source. It needs no token and stores nothing.
