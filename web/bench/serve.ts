// Serves `/<root name>/<path>` from the directory registered under that name, with Range and CORS.
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join, normalize } from "node:path";

export interface FileServer {
  /** `http://127.0.0.1:<port>`. */
  readonly origin: string;
  close(): void;
}

export async function serveRoots(roots: Readonly<Record<string, string>>): Promise<FileServer> {
  const server = createServer((req, res) => {
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Range",
      "Access-Control-Expose-Headers": "Content-Range, Content-Length",
      "Cross-Origin-Resource-Policy": "cross-origin",
    };
    if (req.method === "OPTIONS") return void res.writeHead(204, cors).end();
    const [, root = "", ...rest] = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname).split("/");
    const base = roots[root];
    const path = base === undefined ? undefined : normalize(join(base, ...rest));
    let size = -1;
    try {
      if (path !== undefined && base !== undefined && path.startsWith(base)) size = statSync(path).size;
    } catch {
      size = -1;
    }
    if (path === undefined || size < 0) return void res.writeHead(404, cors).end();
    const m = /^bytes=(\d+)-$/.exec(req.headers.range ?? "");
    const start = m?.[1] === undefined ? 0 : Number(m[1]);
    res.writeHead(m === null ? 200 : 206, {
      ...cors,
      "Content-Type": "application/octet-stream",
      "Content-Length": size - start,
      ...(m === null ? {} : { "Content-Range": `bytes ${start}-${size - 1}/${size}` }),
    });
    createReadStream(path, { start }).pipe(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => void server.close() };
}
