import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { config } from "../config.js";
import { badRequest } from "../errors.js";

export interface StoredFile {
  key: string;
  sha256: string;
  size: number;
}

export interface StorageAdapter {
  put(buf: Buffer, suggestedName: string): Promise<StoredFile>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

class MemoryStorage implements StorageAdapter {
  private map = new Map<string, Buffer>();
  async put(buf: Buffer): Promise<StoredFile> {
    const sha256 = createHash("sha256").update(buf).digest("hex");
    const key = `mem/${sha256}`;
    this.map.set(key, buf);
    return { key, sha256, size: buf.byteLength };
  }
  async get(key: string): Promise<Buffer> {
    const b = this.map.get(key);
    if (!b) throw badRequest("file missing from store");
    return b;
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
}

class DiskStorage implements StorageAdapter {
  constructor(private dir: string) {}
  private async ensure() {
    await fs.mkdir(this.dir, { recursive: true });
  }
  async put(buf: Buffer): Promise<StoredFile> {
    await this.ensure();
    const sha256 = createHash("sha256").update(buf).digest("hex");
    const key = `${sha256.slice(0, 2)}/${sha256}`;
    const p = path.join(this.dir, key);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, buf);
    return { key, sha256, size: buf.byteLength };
  }
  async get(key: string): Promise<Buffer> {
    const p = path.join(this.dir, key);
    if (!p.startsWith(path.resolve(this.dir))) throw badRequest("bad key");
    try {
      return await fs.readFile(p);
    } catch {
      throw badRequest("file missing from store");
    }
  }
  async delete(key: string): Promise<void> {
    const p = path.join(this.dir, key);
    await fs.rm(p, { force: true });
  }
}

let adapter: StorageAdapter | null = null;

export function storage(): StorageAdapter {
  if (!adapter) {
    adapter =
      config.STORAGE_DRIVER === "memory"
        ? new MemoryStorage()
        : new DiskStorage(config.STORAGE_DIR);
  }
  return adapter;
}
