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

const UPSTREAM = "https://huggingface.co";

// The models MimiVox downloads. Override with the ALLOWED_REPOS variable
// (comma-separated repo ids, or "*" for any public repo).
const DEFAULT_REPOS = [
  "LibraxisAI/whisper-large-v3-turbo-mlx-q8",
  "basyauma-tech/Haas-ja-v1.0-mlx-8bit",
  "hotchpotch/CAT-Translate-1.4b-mlx-q4",
  "mlx-community/Qwen3-4B-Instruct-2507-4bit",
  "Wespeaker/wespeaker-voxceleb-resnet34-LM",
];

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

const REPO = "[A-Za-z0-9][\\w.-]*/[\\w.-]+";
const API_ROUTE = new RegExp(`^/api/models/(${REPO})(?:/revision/[^/]+)?/?$`);
const RESOLVE_ROUTE = new RegExp(`^/(${REPO})/resolve/[^/]+/.+$`);
// The Hub answers resolve requests for small files with a relative redirect here.
const RESOLVE_CACHE_ROUTE = new RegExp(`^/api/resolve-cache/models/(${REPO})/[^/]+/.+$`);
const CDN_ROUTE = /^\/_cdn\/([\w-]+)\/([a-z0-9.-]+)(\/.*)$/;

export default {
  async fetch(request, env) {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return text(405, "Only GET and HEAD are allowed.", { allow: "GET, HEAD" });
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

    const repo = [API_ROUTE, RESOLVE_ROUTE, RESOLVE_CACHE_ROUTE].map((route) => path.match(route)?.[1]).find(Boolean);
    if (!repo) return text(404, "Not found.");
    if (!repoAllowed(repo, env)) return text(403, `Repository ${repo} is not served by this proxy.`);
    return proxy(request, `${UPSTREAM}${path}${url.search}`, url.origin, key);
  },
};

async function proxy(request, target, origin, key) {
  // Cloudflare rewrites the client's Accept-Encoding to "br, gzip". A compressed
  // upstream reply loses its Content-Length and gets a weak ETag, and
  // huggingface_hub rejects both, so always ask for the raw bytes.
  const headers = new Headers({ "user-agent": "mimivox-hf-proxy", "accept-encoding": "identity" });
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }

  const upstream = await fetch(target, { method: request.method, headers, redirect: "manual" });

  const out = new Headers(upstream.headers);
  for (const name of DROPPED_HEADERS) out.delete(name);

  const location = out.get("location");
  if (location) out.set("location", await rewriteLocation(location, target, origin, key));

  return new Response(request.method === "HEAD" ? null : upstream.body, {
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
  return new Response(body + "\n", { status, headers: { "content-type": "text/plain; charset=utf-8", ...extra } });
}
