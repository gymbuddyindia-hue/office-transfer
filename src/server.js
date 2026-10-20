import { loadConfig } from './config.js';
import { createApp } from './app.js';

const config = loadConfig();
const { app, cleanup, close } = createApp(config);

const server = app.listen(config.port, config.host, () => {
  console.log(`${config.appName} listening on http://${config.host}:${config.port}`);
  console.log(`data dir: ${config.dataDir}`);
  console.log(`upload code: ${config.uploadCode ? 'required' : 'not set (anyone who can reach this server can upload)'}`);
  console.log(`email: ${config.smtp ? `via ${config.smtp.host}` : 'disabled (no SMTP_HOST)'}`);
});
// Multi-GB uploads and downloads must not be killed by idle timeouts.
server.requestTimeout = 0;
server.headersTimeout = 60000;
server.keepAliveTimeout = 65000;

const timer = setInterval(() => {
  cleanup().then((ids) => { if (ids.length) console.log(`cleanup removed ${ids.length} transfer(s)`); })
    .catch((err) => console.error('cleanup error', err));
}, config.cleanupIntervalMs);
cleanup().catch((err) => console.error('cleanup error', err));

function shutdown() {
  clearInterval(timer);
  server.close(() => { close(); process.exit(0); });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
