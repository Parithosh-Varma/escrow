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

class S3Storage implements StorageAdapter {
  private bucket: string;
  private client: any = null;

  constructor() {
    this.bucket = config.S3_BUCKET!;
  }

  private getClient() {
    if (!this.client) {
      const { S3Client } = require("@aws-sdk/client-s3");
      this.client = new S3Client({
        region: config.S3_REGION || "us-east-1",
        ...(config.S3_ENDPOINT ? { endpoint: config.S3_ENDPOINT, forcePathStyle: true } : {}),
        credentials: config.S3_ACCESS_KEY_ID && config.S3_SECRET_ACCESS_KEY
          ? { accessKeyId: config.S3_ACCESS_KEY_ID, secretAccessKey: config.S3_SECRET_ACCESS_KEY }
          : undefined
      });
    }
    return this.client;
  }

  async put(buf: Buffer): Promise<StoredFile> {
    const { PutObjectCommand } = require("@aws-sdk/client-s3");
    const sha256 = createHash("sha256").update(buf).digest("hex");
    const key = `escrow/${sha256.slice(0, 2)}/${sha256}`;
    await this.getClient().send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: buf })
    );
    return { key, sha256, size: buf.byteLength };
  }

  async get(key: string): Promise<Buffer> {
    const { GetObjectCommand } = require("@aws-sdk/client-s3");
    try {
      const res = await this.getClient().send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key })
      );
      const chunks: Buffer[] = [];
      for await (const chunk of res.Body as AsyncIterable<Buffer>) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    } catch (err: any) {
      if (err.name === "NoSuchKey" || err.$?.httpStatusCode === 404) {
        throw badRequest("file missing from store");
      }
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    const { DeleteObjectCommand } = require("@aws-sdk/client-s3");
    await this.getClient().send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: key })
    );
  }
}

let adapter: StorageAdapter | null = null;

export function storage(): StorageAdapter {
  if (!adapter) {
    switch (config.STORAGE_DRIVER) {
      case "s3":
        adapter = new S3Storage();
        break;
      case "memory":
        adapter = new MemoryStorage();
        break;
      default:
        adapter = new DiskStorage(config.STORAGE_DIR);
    }
  }
  return adapter;
}
