import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface ServedFile {
  readonly path: string;
  readonly body: Buffer;
  readonly sha256: string;
}

export interface RecordedRequest {
  readonly path: string;
  readonly range: string | null;
}

/** A throttled static server with Range and CORS support, standing in for huggingface.co. */
export class ModelServer {
  readonly requests: RecordedRequest[] = [];
  private server: Server | undefined;

  constructor(
    readonly files: readonly ServedFile[],
    private readonly bytesPerSecond: number,
  ) {}

  static withRandomFile(path: string, size: number, bytesPerSecond: number): ModelServer {
    const body = randomBytes(size);
    return new ModelServer([{ path, body, sha256: createHash("sha256").update(body).digest("hex") }], bytesPerSecond);
  }

  get origin(): string {
    return `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const cors = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Range",
        "Access-Control-Expose-Headers": "Content-Range, Content-Length",
      };
      if (req.method === "OPTIONS") {
        res.writeHead(204, cors).end();
        return;
      }
      const path = new URL(req.url ?? "/", "http://x").pathname;
      const file = this.files.find((f) => `/${f.path}` === path);
      if (file === undefined) {
        res.writeHead(404, cors).end();
        return;
      }
      const range = req.headers.range ?? null;
      this.requests.push({ path, range });
      const start = range === null ? 0 : Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0);
      const total = file.body.length;
      res.writeHead(range === null ? 200 : 206, {
        ...cors,
        "Content-Type": "application/octet-stream",
        "Content-Length": total - start,
        ...(range === null ? {} : { "Content-Range": `bytes ${start}-${total - 1}/${total}` }),
      });
      const piece = 64 * 1024;
      const delay = (piece / this.bytesPerSecond) * 1000;
      let pos = start;
      const timer = setInterval(() => {
        if (pos >= total) {
          clearInterval(timer);
          res.end();
          return;
        }
        res.write(file.body.subarray(pos, Math.min(pos + piece, total)));
        pos += piece;
      }, delay);
      res.on("close", () => clearInterval(timer));
    });
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r));
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((r) => this.server?.close(() => r()));
  }
}
