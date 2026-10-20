import path from 'node:path';

const MB = 1024 * 1024;

function intFrom(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number, got "${raw}"`);
  return n;
}

export function loadConfig(env = process.env) {
  const int = (name, fallback) => intFrom(env, name, fallback);
  const dataDir = path.resolve(env.DATA_DIR || './data');
  const cfg = {
    port: int('PORT', 3000),
    host: env.HOST || '0.0.0.0',
    dataDir,
    filesDir: path.join(dataDir, 'files'),
    tmpDir: path.join(dataDir, 'tmp'),
    dbPath: path.join(dataDir, 'transfer.sqlite'),
    // Public URL used in share links and emails. Falls back to the request origin.
    baseUrl: (env.BASE_URL || '').replace(/\/+$/, ''),
    // Shared code staff must enter to upload. Empty disables the gate.
    uploadCode: env.UPLOAD_CODE || '',
    chunkSize: int('CHUNK_SIZE_MB', 8) * MB,
    // 0 means unlimited.
    maxTransferBytes: int('MAX_TRANSFER_GB', 0) * 1024 * MB,
    defaultExpiryDays: int('DEFAULT_EXPIRY_DAYS', 7),
    abandonedUploadHours: int('ABANDONED_UPLOAD_HOURS', 24),
    cleanupIntervalMs: int('CLEANUP_INTERVAL_MINUTES', 10) * 60 * 1000,
    appName: env.APP_NAME || 'BuddyBeam',
    // 'local' keeps files on disk under DATA_DIR. 's3' stores them in any S3-compatible bucket
    // (Cloudflare R2, Backblaze B2, MinIO, AWS) so the server itself can be diskless.
    storage: (env.STORAGE || 'local').toLowerCase(),
    s3: {
      endpoint: env.S3_ENDPOINT || '',
      region: env.S3_REGION || 'auto',
      bucket: env.S3_BUCKET || '',
      accessKeyId: env.S3_ACCESS_KEY_ID || '',
      secretAccessKey: env.S3_SECRET_ACCESS_KEY || '',
      forcePathStyle: env.S3_FORCE_PATH_STYLE !== 'false',
      prefix: (env.S3_PREFIX || '').replace(/^\/+|\/+$/g, ''),
    },
    // In s3 mode, keep a copy of the SQLite index in the bucket (for hosts without a persistent disk).
    dbSync: env.DB_SYNC !== 'false',
    dbSyncDebounceMs: int('DB_SYNC_DEBOUNCE_MS', 3000),
    smtp: env.SMTP_HOST
      ? {
          host: env.SMTP_HOST,
          port: int('SMTP_PORT', 587),
          secure: env.SMTP_SECURE === 'true',
          user: env.SMTP_USER || '',
          pass: env.SMTP_PASS || '',
          from: env.SMTP_FROM || env.SMTP_USER || 'transfer@localhost',
        }
      : null,
  };
  if (cfg.storage === 's3') {
    for (const k of ['bucket', 'accessKeyId', 'secretAccessKey']) {
      if (!cfg.s3[k]) throw new Error(`STORAGE=s3 needs S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY`);
    }
    // S3 multipart parts must be at least 5 MB except the last one.
    if (cfg.chunkSize < 5 * MB) cfg.chunkSize = 5 * MB;
  } else if (cfg.storage !== 'local') {
    throw new Error(`STORAGE must be "local" or "s3", got "${cfg.storage}"`);
  }
  return cfg;
}
