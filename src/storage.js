import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

export class Storage {
  constructor({ filesDir, tmpDir }) {
    this.filesDir = filesDir;
    this.tmpDir = tmpDir;
    fs.mkdirSync(filesDir, { recursive: true });
    fs.mkdirSync(tmpDir, { recursive: true });
  }

  /** Called once per file at transfer creation. Local disk needs nothing. */
  async prepareFiles() {}

  /** Null means "stream it through this server"; the S3 backend returns a presigned URL instead. */
  async downloadUrl() { return null; }

  readStream(fileId, range) {
    return fs.createReadStream(this.finalPath(fileId), range ? { start: range.start, end: range.end } : undefined);
  }

  chunkDir(fileId) { return path.join(this.tmpDir, fileId); }
  chunkPath(fileId, n) { return path.join(this.chunkDir(fileId), String(n)); }
  finalPath(fileId) { return path.join(this.filesDir, fileId); }

  /** Write one chunk from a stream. Returns bytes written. */
  async writeChunk(fileId, n, stream) {
    const dir = this.chunkDir(fileId);
    await fsp.mkdir(dir, { recursive: true });
    const partial = path.join(dir, `${n}.part`);
    const out = fs.createWriteStream(partial);
    try {
      await pipeline(stream, out);
    } catch (err) {
      await fsp.rm(partial, { force: true });
      throw err;
    }
    await fsp.rename(partial, this.chunkPath(fileId, n));
    const st = await fsp.stat(this.chunkPath(fileId, n));
    return st.size;
  }

  /** Which chunk indexes exist on disk, with their sizes. */
  async chunkStatus(fileId) {
    let names;
    try {
      names = await fsp.readdir(this.chunkDir(fileId));
    } catch (err) {
      if (err.code === 'ENOENT') return new Map();
      throw err;
    }
    const out = new Map();
    for (const name of names) {
      if (!/^\d+$/.test(name)) continue;
      const st = await fsp.stat(path.join(this.chunkDir(fileId), name));
      out.set(Number(name), st.size);
    }
    return out;
  }

  /** Concatenate chunks 0..total-1 into the final file. Throws listing missing chunks. */
  async assemble(fileId, chunksTotal, expectedSize) {
    const have = await this.chunkStatus(fileId);
    const missing = [];
    for (let i = 0; i < chunksTotal; i++) if (!have.has(i)) missing.push(i);
    if (missing.length) {
      const err = new Error(`Missing chunks: ${missing.slice(0, 20).join(', ')}${missing.length > 20 ? '…' : ''}`);
      err.code = 'MISSING_CHUNKS';
      err.missing = missing;
      throw err;
    }
    const finalPath = this.finalPath(fileId);
    const partial = `${finalPath}.part`;
    const out = fs.createWriteStream(partial);
    try {
      for (let i = 0; i < chunksTotal; i++) {
        await pipeline(fs.createReadStream(this.chunkPath(fileId, i)), out, { end: false });
      }
      await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
    } catch (err) {
      out.destroy();
      await fsp.rm(partial, { force: true });
      throw err;
    }
    const st = await fsp.stat(partial);
    if (st.size !== expectedSize) {
      await fsp.rm(partial, { force: true });
      const err = new Error(`Assembled size ${st.size} does not match declared size ${expectedSize}`);
      err.code = 'SIZE_MISMATCH';
      throw err;
    }
    await fsp.rename(partial, finalPath);
    await fsp.rm(this.chunkDir(fileId), { recursive: true, force: true });
    return st.size;
  }

  async removeChunk(fileId, n) {
    await fsp.rm(this.chunkPath(fileId, n), { force: true });
  }

  async removeFile(fileId) {
    await fsp.rm(this.finalPath(fileId), { force: true });
    await fsp.rm(`${this.finalPath(fileId)}.part`, { force: true });
    await fsp.rm(this.chunkDir(fileId), { recursive: true, force: true });
  }

  async freeBytes() {
    try {
      const st = await fsp.statfs(this.filesDir);
      return st.bavail * st.bsize;
    } catch {
      return null;
    }
  }
}
