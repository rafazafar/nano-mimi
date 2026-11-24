// Development stand-in for the model host: serves a local transformers.js model dir at
// <endpoint>/<repo>/resolve/<revision>/<path>, the layout the model store's manifest expects.
// Range and CORS supported. Nothing is uploaded anywhere.
//
//   node bench/mt.server.mjs [port] [model dir]
//   (defaults: 8790, $MIMIVOX_CAT_DIR or ~/.cache/mimivox/web-models/cat-ogb-q4)
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const port = Number(process.argv[2] ?? 8790);
const dir = path.resolve(process.argv[3] ?? process.env.MIMIVOX_CAT_DIR ?? path.join(os.homedir(), ".cache/mimivox/web-models/cat-ogb-q4"));
const ROUTE = /^\/[^/]+\/[^/]+\/resolve\/[^/]+\/(.+)$/;

const server = http.createServer((req, res) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Range",
    "Access-Control-Expose-Headers": "Content-Range, Content-Length",
  };
  if (req.method === "OPTIONS") return res.writeHead(204, cors).end();
  const m = ROUTE.exec(decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname));
  const file = m === null ? null : path.join(dir, m[1]);
  if (file === null || !file.startsWith(dir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    return res.writeHead(404, cors).end();
  }
  const size = fs.statSync(file).size;
  const range = /^bytes=(\d+)-/.exec(req.headers.range ?? "");
  const start = range === null ? 0 : Number(range[1]);
  res.writeHead(range === null ? 200 : 206, {
    ...cors,
    "Content-Type": "application/octet-stream",
    "Content-Length": size - start,
    ...(range === null ? {} : { "Content-Range": `bytes ${start}-${size - 1}/${size}` }),
  });
  fs.createReadStream(file, { start }).pipe(res);
});
server.listen(port, "127.0.0.1", () => console.log(`serving ${dir} on http://127.0.0.1:${port}`));
