// Anonymous, read-only Hugging Face download proxy for MimiVox.
//
// Point the app's Download Source (HF_ENDPOINT) at this worker. It serves the
// paths huggingface_hub uses and keeps every byte on the worker's origin:
//
//   /api/models/<repo>[/revision/<rev>]   repo metadata (snapshot_download, model_info)
//   /<repo>/resolve/<rev>/<file>          file downloads
//   /api/resolve-cache/models/<repo>/...  where the Hub redirects small-file downloads
//   /_cdn/<sig>/<host>/<path>?<query>     signed CDN redirects, rewritten by this worker
//
// The Hub answers large files with a redirect to a CDN host (cas-bridge.xethub.hf.co,
// cdn-lfs.hf.co, ...). A client that cannot reach huggingface.co usually cannot
// reach those either, so the worker rewrites the Location header to its own /_cdn/
// route. <sig> is an HMAC of the CDN URL under the CDN_SIGNING_KEY secret, so the
// route serves only redirects this worker issued for an allowed repo, never a
// storage URL that a caller fetched from the Hub for another repo. It also drops the Xet headers, which makes huggingface_hub fall back to a
// plain HTTP download instead of talking to the Xet storage service directly.
//
// Browsers can fetch from it too: every reply allows any origin and carries
// Cross-Origin-Resource-Policy, so a cross-origin-isolated (COEP) page can load it.

const UPSTREAM = "https://huggingface.co";

// The models MimiVox downloads. Override with the ALLOWED_REPOS variable
// (comma-separated repo ids, or "*" for any public repo).
const DEFAULT_REPOS = [
  "LibraxisAI/whisper-large-v3-turbo-mlx-q8",
  "basyauma-tech/Haas-ja-v1.0-mlx-8bit",
  "hotchpotch/CAT-Translate-1.4b-mlx-q4",
  "mlx-community/Qwen3-4B-Instruct-2507-4bit",
  "Wespeaker/wespeaker-voxceleb-resnet34-LM",
  // The browser app's models (ONNX).
  "rafazafar/CAT-Translate-1.4b-onnx-q4f16",
  "basyauma-tech/Haas-ja-v1.0-onnx",
  "Sanami/haas-ja-onnx",
  "kizuna-intelligence/Haas-ja-v1.0-OneCompression-ONNX",
];

// Files pinned to a commit sha are immutable, so they can be copied into the
// MODELS R2 bucket under <repo>/<sha>/<path> (see scripts/seed_model_mirror.mjs)
// and served from there when the Hub is down. Other revisions always go to the Hub.
const COMMIT_SHA = /^[0-9a-f]{40}$/;

// Response headers that would steer the client away from this worker.
const DROPPED_HEADERS = [
  "link",
  "x-xet-hash",
  "x-xet-refresh-route",
  "x-xet-endpoint",
  "x-xet-access-token",
  "x-xet-expiration",
  "set-cookie",
];

// Request headers worth passing upstream. Everything else, including
// Authorization and Cookie, stays behind: the proxy is anonymous.
const FORWARDED_REQUEST_HEADERS = ["range", "if-none-match", "if-match", "if-range", "accept"];

// Replaces the Hub's own CORS headers, which allow only huggingface.co.
const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-expose-headers":
    "Content-Length, Content-Range, Accept-Ranges, ETag, X-Repo-Commit, X-Linked-ETag, X-Linked-Size, X-Mimivox-Source",
  "cross-origin-resource-policy": "cross-origin",
};

const REPO = "[A-Za-z0-9][\\w.-]*/[\\w.-]+";
const API_ROUTE = new RegExp(`^/api/models/(${REPO})(?:/revision/[^/]+)?/?$`);
const RESOLVE_ROUTE = new RegExp(`^/(${REPO})/resolve/([^/]+)/(.+)$`);
// The Hub answers resolve requests for small files with a relative redirect here.
const RESOLVE_CACHE_ROUTE = new RegExp(`^/api/resolve-cache/models/(${REPO})/[^/]+/.+$`);
const CDN_ROUTE = /^\/_cdn\/([\w-]+)\/([a-z0-9.-]+)(\/.*)$/;

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          ...CORS_HEADERS,
          "access-control-allow-methods": "GET, HEAD, OPTIONS",
          "access-control-allow-headers": request.headers.get("access-control-request-headers") ?? "",
          "access-control-max-age": "86400",
        },
      });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return text(405, "Only GET and HEAD are allowed.", { allow: "GET, HEAD, OPTIONS" });
    }
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/" || path === "") {
      return text(200, "MimiVox Hugging Face proxy. Use this address as the Download Source.");
    }

    if (!env.CDN_SIGNING_KEY) {
      return text(500, "Set the CDN_SIGNING_KEY secret: npx wrangler secret put CDN_SIGNING_KEY");
    }
    const key = await signingKey(env.CDN_SIGNING_KEY);

    const cdn = path.match(CDN_ROUTE);
    if (cdn) {
      const [, sig, host, rest] = cdn;
      const target = `https://${host}${rest}${url.search}`;
      if (!isHubCdnHost(host) || !(await verify(key, sig, target))) return text(403, "Link not issued by this proxy.");
      return proxy(request, target, url.origin, key);
    }

    const match = [API_ROUTE, RESOLVE_ROUTE, RESOLVE_CACHE_ROUTE].map((route) => path.match(route)).find(Boolean);
    if (!match) return text(404, "Not found.");
    const repo = match[1];
    if (!repoAllowed(repo, env)) return text(403, `Repository ${repo} is not served by this proxy.`);
    // Only RESOLVE_ROUTE captures a revision and file path.
    if (match[2] && match[3] && COMMIT_SHA.test(match[2]) && env.MODELS) {
      const hit = await serveFromBucket(request, env.MODELS, `${repo}/${match[2]}/${safeDecode(match[3])}`);
      if (hit) return hit;
    }
    return proxy(request, `${UPSTREAM}${path}${url.search}`, url.origin, key);
  },
};

function safeDecode(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// Parses a single "bytes=" range. Returns null when there is no usable range
// (serve the whole object) and "invalid" when it lies outside the object.
function parseRange(header, size) {
  const m = /^bytes=([0-9]*)-([0-9]*)$/.exec(header ?? "");
  if (!m || (m[1] === "" && m[2] === "")) return null;
  let start;
  let end;
  if (m[1] === "") {
    const n = Number(m[2]);
    if (n === 0) return "invalid";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start >= size || start > end) return "invalid";
  return { start, end };
}

// Serves a sha-pinned file from R2, or returns null when the bucket lacks it.
async function serveFromBucket(request, bucket, objectKey) {
  const head = await bucket.head(objectKey);
  if (!head) return null;
  const { size, httpEtag: etag } = head;
  const headers = new Headers({
    ...CORS_HEADERS,
    "accept-ranges": "bytes",
    etag,
    "content-type": head.httpMetadata?.contentType ?? "application/octet-stream",
    "cache-control": "public, max-age=31536000, immutable",
    "x-mimivox-source": "r2",
  });
  if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });

  const ifRange = request.headers.get("if-range");
  const range = ifRange && ifRange !== etag ? null : parseRange(request.headers.get("range"), size);
  if (range === "invalid") {
    headers.set("content-range", `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }
  const length = range ? range.end - range.start + 1 : size;
  headers.set("content-length", String(length));
  if (range) headers.set("content-range", `bytes ${range.start}-${range.end}/${size}`);
  const status = range ? 206 : 200;
  if (request.method === "HEAD") return new Response(null, { status, headers });

  const options = { onlyIf: { etagMatches: head.etag } };
  if (range) options.range = { offset: range.start, length };
  const object = await bucket.get(objectKey, options);
  if (!object || !("body" in object)) return null;
  return new Response(object.body, { status, headers });
}

async function proxy(request, target, origin, key) {
  const headers = new Headers({ "user-agent": "mimivox-hf-proxy", "accept-encoding": "identity" });
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  let upstream = await fetch(target, { method: request.method, headers, redirect: "manual" });

  // Deployed Workers ask the Hub for gzip whatever Accept-Encoding says, and
  // hand back the decoded body without Content-Length and with a weak ETag.
  // huggingface_hub rejects both. Only small text files arrive compressed, so
  // buffer those to restore the length, and restore the ETag of the raw bytes.
  let body = upstream.body;
  const compressed = upstream.status === 200 && !upstream.headers.has("content-length");
  if (compressed) {
    if (request.method === "HEAD") upstream = await fetch(target, { method: "GET", headers, redirect: "manual" });
    body = await upstream.arrayBuffer();
  }

  const out = new Headers(upstream.headers);
  for (const name of DROPPED_HEADERS) out.delete(name);
  for (const name of [...out.keys()]) if (name.startsWith("access-control-")) out.delete(name);
  for (const [name, value] of Object.entries(CORS_HEADERS)) out.set(name, value);
  if (compressed) {
    out.delete("content-encoding");
    out.set("content-length", String(body.byteLength));
    // Cloudflare's edge drops Content-Length from HEAD replies with a text type.
    // huggingface_hub reads the size from X-Linked-Size first.
    out.set("x-linked-size", String(body.byteLength));
    const etag = out.get("etag");
    if (etag?.startsWith("W/")) out.set("etag", etag.slice(2));
  }

  const location = out.get("location");
  if (location) out.set("location", await rewriteLocation(location, target, origin, key));

  out.set("x-mimivox-source", "hub");
  return new Response(request.method === "HEAD" ? null : body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: out,
  });
}

// Keep redirects on this worker: Hub redirects stay as Hub paths, CDN redirects
// go through /_cdn/<host>/. Relative redirects (repo renames) stay relative,
// because huggingface_hub follows only those during its metadata HEAD.
async function rewriteLocation(location, base, origin, key) {
  const relative = location.startsWith("/") && !location.startsWith("//");
  if (relative && base.startsWith(UPSTREAM)) return location;
  const target = new URL(location, base);
  if (target.origin === UPSTREAM) return `${origin}${target.pathname}${target.search}`;
  if (target.protocol === "https:" && isHubCdnHost(target.hostname)) {
    return `${origin}/_cdn/${await sign(key, target.href)}/${target.hostname}${target.pathname}${target.search}`;
  }
  return target.href;
}

// Only the storage hosts the Hub redirects to. hf.co and huggingface.co
// themselves are excluded so /_cdn/ cannot bypass the repo allowlist.
function isHubCdnHost(host) {
  return (
    host.endsWith(".cdn.hf.co") ||
    host.endsWith(".xethub.hf.co") ||
    /^cdn-lfs[a-z0-9-]*\.(hf|huggingface)\.co$/.test(host)
  );
}

async function signingKey(secret) {
  const raw = new TextEncoder().encode(secret);
  return crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function sign(key, target) {
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(target));
  return btoa(String.fromCharCode(...new Uint8Array(mac))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// crypto.subtle.verify compares in constant time.
async function verify(key, sig, target) {
  let mac;
  try {
    mac = Uint8Array.from(atob(sig.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  } catch {
    return false;
  }
  return crypto.subtle.verify("HMAC", key, mac, new TextEncoder().encode(target));
}

function repoAllowed(repo, env) {
  const configured = env.ALLOWED_REPOS?.trim();
  if (configured === "*") return true;
  const allowed = configured ? configured.split(",").map((r) => r.trim()) : DEFAULT_REPOS;
  return allowed.includes(repo);
}

function text(status, body, extra = {}) {
  return new Response(body + "\n", { status, headers: { "content-type": "text/plain; charset=utf-8", ...CORS_HEADERS, ...extra } });
}
