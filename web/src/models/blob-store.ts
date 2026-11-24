export interface StoredEntry {
  readonly name: string;
  readonly size: number;
}

/**
 * Minimal storage surface the model store needs. Directories are `/`-separated keys with at
 * least two segments. Writes are atomic per entry: an entry is either fully present or
 * absent, which is what makes a tab killed mid-download safe to resume.
 */
export interface BlobStore {
  list(dir: string): Promise<readonly StoredEntry[]>;
  /** Names of the subdirectories of `dir` ("" is the root). */
  listDirs(dir: string): Promise<readonly string[]>;
  write(dir: string, name: string, data: Uint8Array): Promise<void>;
  read(dir: string, name: string): Promise<Blob>;
  remove(dir: string, name: string): Promise<void>;
  removeDir(dir: string): Promise<void>;
}

const ROOT = "mimivox-models";

function isNotFound(e: unknown): boolean {
  return e instanceof DOMException && e.name === "NotFoundError";
}

export class OpfsBlobStore implements BlobStore {
  private async dirHandle(dir: string, create: boolean): Promise<FileSystemDirectoryHandle | null> {
    let handle = await navigator.storage.getDirectory();
    for (const seg of [ROOT, ...dir.split("/").filter((s) => s !== "")]) {
      try {
        handle = await handle.getDirectoryHandle(seg, { create });
      } catch (e) {
        if (!create && isNotFound(e)) return null;
        throw e;
      }
    }
    return handle;
  }

  async list(dir: string): Promise<readonly StoredEntry[]> {
    const handle = await this.dirHandle(dir, false);
    if (handle === null) return [];
    const out: StoredEntry[] = [];
    for await (const entry of handle.values()) {
      if (entry.kind === "file") {
        out.push({ name: entry.name, size: (await (entry as FileSystemFileHandle).getFile()).size });
      }
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  async listDirs(dir: string): Promise<readonly string[]> {
    const handle = await this.dirHandle(dir, false);
    if (handle === null) return [];
    const out: string[] = [];
    for await (const entry of handle.values()) if (entry.kind === "directory") out.push(entry.name);
    return out.sort();
  }

  async write(dir: string, name: string, data: Uint8Array): Promise<void> {
    const handle = await this.dirHandle(dir, true);
    const file = await handle!.getFileHandle(name, { create: true });
    const w = await file.createWritable();
    try {
      await w.write(data as Uint8Array<ArrayBuffer>);
      await w.close();
    } catch (e) {
      await w.abort().catch(() => undefined);
      throw e;
    }
  }

  async read(dir: string, name: string): Promise<Blob> {
    const handle = await this.dirHandle(dir, false);
    if (handle === null) throw new Error(`missing ${dir}/${name}`);
    return (await handle.getFileHandle(name)).getFile();
  }

  async remove(dir: string, name: string): Promise<void> {
    const handle = await this.dirHandle(dir, false);
    try {
      await handle?.removeEntry(name);
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
  }

  async removeDir(dir: string): Promise<void> {
    const segs = dir.split("/");
    const last = segs.pop()!;
    const parent = await this.dirHandle(segs.join("/"), false);
    try {
      await parent?.removeEntry(last, { recursive: true });
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
  }
}

export class MemoryBlobStore implements BlobStore {
  private readonly dirs = new Map<string, Map<string, Uint8Array>>();

  async list(dir: string): Promise<readonly StoredEntry[]> {
    return [...(this.dirs.get(dir) ?? [])]
      .map(([name, d]) => ({ name, size: d.length }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
  }

  async listDirs(dir: string): Promise<readonly string[]> {
    const prefix = dir === "" ? "" : `${dir}/`;
    const names = new Set<string>();
    for (const d of this.dirs.keys()) if (d.startsWith(prefix)) names.add(d.slice(prefix.length).split("/")[0]!);
    return [...names].sort();
  }

  async write(dir: string, name: string, data: Uint8Array): Promise<void> {
    const d = this.dirs.get(dir) ?? new Map<string, Uint8Array>();
    d.set(name, data.slice());
    this.dirs.set(dir, d);
  }

  async read(dir: string, name: string): Promise<Blob> {
    const d = this.dirs.get(dir)?.get(name);
    if (d === undefined) throw new Error(`missing ${dir}/${name}`);
    return new Blob([d as Uint8Array<ArrayBuffer>]);
  }

  async remove(dir: string, name: string): Promise<void> {
    this.dirs.get(dir)?.delete(name);
  }

  async removeDir(dir: string): Promise<void> {
    for (const d of [...this.dirs.keys()]) if (d === dir || d.startsWith(`${dir}/`)) this.dirs.delete(d);
  }
}
