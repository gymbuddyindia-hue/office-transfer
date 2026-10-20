/* S3-compatible backend (Cloudflare R2, Backblaze B2, MinIO, AWS S3).
 * Chunks become multipart-upload parts. Part ETags are tracked in SQLite so
 * status and resume do not depend on ListParts, which some providers lack. */
import {
  S3Client, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand, PutObjectCommand, HeadObjectCommand, GetObjectCommand, DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export class S3Storage {
  constructor(config, db) {
    const s3 = config.s3;
    this.bucket = s3.bucket;
    this.prefix = s3.prefix ? `${s3.prefix}/` : '';
    this.db = db;
    this.client = new S3Client({
      region: s3.region,
      endpoint: s3.endpoint || undefined,
      forcePathStyle: s3.forcePathStyle,
      credentials: { accessKeyId: s3.accessKeyId, secretAccessKey: s3.secretAccessKey },
      // Newer SDKs add CRC32 trailers with aws-chunked encoding by default, which R2, B2
      // and MinIO do not all accept. Plain bodies with a known Content-Length work everywhere.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  key(fileId) { return `${this.prefix}${fileId}`; }

  async prepareFiles(files) {
    for (const f of files) {
      if (f.size === 0) continue; // written with a single PutObject on assemble
      const res = await this.client.send(new CreateMultipartUploadCommand({
        Bucket: this.bucket, Key: this.key(f.id), ContentType: 'application/octet-stream',
      }));
      this.db.setUploadId(f.id, res.UploadId);
    }
  }

  async writeChunk(fileId, n, stream, expectedSize) {
    const file = this.db.getFileById(fileId);
    if (!file) throw new Error('unknown file');
    if (file.size === 0) {
      stream.resume();
      this.db.upsertPart(fileId, 0, 'empty', 0);
      return 0;
    }
    const res = await this.client.send(new UploadPartCommand({
      Bucket: this.bucket, Key: this.key(fileId), UploadId: file.upload_id,
      PartNumber: n + 1, Body: stream, ContentLength: expectedSize,
    }));
    this.db.upsertPart(fileId, n, res.ETag, expectedSize);
    return expectedSize;
  }

  async removeChunk(fileId, n) {
    // A failed UploadPart leaves nothing to clean; make sure it is not counted.
    this.db.raw.prepare('DELETE FROM parts WHERE file_id = ? AND n = ?').run(fileId, n);
  }

  async chunkStatus(fileId) {
    return new Map(this.db.getParts(fileId).map((p) => [p.n, p.size]));
  }

  async assemble(fileId, chunksTotal, expectedSize) {
    const parts = this.db.getParts(fileId);
    const have = new Set(parts.map((p) => p.n));
    const missing = [];
    for (let i = 0; i < chunksTotal; i++) if (!have.has(i)) missing.push(i);
    if (missing.length) {
      const err = new Error(`Missing chunks: ${missing.slice(0, 20).join(', ')}${missing.length > 20 ? '…' : ''}`);
      err.code = 'MISSING_CHUNKS';
      err.missing = missing;
      throw err;
    }
    const file = this.db.getFileById(fileId);
    if (expectedSize === 0) {
      await this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: this.key(fileId), Body: '', ContentLength: 0 }));
    } else {
      await this.client.send(new CompleteMultipartUploadCommand({
        Bucket: this.bucket, Key: this.key(fileId), UploadId: file.upload_id,
        MultipartUpload: { Parts: parts.map((p) => ({ PartNumber: p.n + 1, ETag: p.etag })) },
      }));
    }
    const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.key(fileId) }));
    if (head.ContentLength !== expectedSize) {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(fileId) })).catch(() => {});
      const err = new Error(`Stored size ${head.ContentLength} does not match declared size ${expectedSize}`);
      err.code = 'SIZE_MISMATCH';
      throw err;
    }
    this.db.deleteParts(fileId);
    return expectedSize;
  }

  async removeFile(fileId) {
    const file = this.db.getFileById(fileId);
    if (file?.upload_id && !file.assembled) {
      await this.client.send(new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: this.key(fileId), UploadId: file.upload_id })).catch(() => {});
    }
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(fileId) })).catch(() => {});
    this.db.deleteParts(fileId);
  }

  async freeBytes() { return null; }

  /** Presigned GET so downloads go straight from the bucket, not through this server. */
  async downloadUrl(fileId, name) {
    const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    return getSignedUrl(this.client, new GetObjectCommand({
      Bucket: this.bucket, Key: this.key(fileId),
      ResponseContentDisposition: `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      ResponseContentType: 'application/octet-stream',
    }), { expiresIn: 3600 });
  }

  async readStream(fileId) {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.key(fileId) }));
    return res.Body;
  }
}
