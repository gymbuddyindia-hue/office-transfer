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
  return {
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
    appName: env.APP_NAME || 'Office Transfer',
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
}
