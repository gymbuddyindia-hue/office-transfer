import nodemailer from 'nodemailer';

export function createMailer(smtp, appName) {
  if (!smtp) return null;
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: smtp.user ? { user: smtp.user, pass: smtp.pass } : undefined,
  });
  return {
    async sendTransfer({ to, link, title, message, senderEmail, files, totalBytes, expiresAt }) {
      const list = files.map((f) => `  • ${f.name} (${formatBytes(f.size)})`).join('\n');
      const expiry = expiresAt ? `This link expires on ${new Date(expiresAt).toUTCString()}.` : 'This link does not expire.';
      const text = [
        `${senderEmail || 'Someone'} sent you ${files.length} file${files.length === 1 ? '' : 's'} (${formatBytes(totalBytes)}) via ${appName}.`,
        title ? `\n${title}` : '',
        message ? `\n${message}\n` : '',
        `\nDownload: ${link}\n`,
        list,
        `\n${expiry}`,
        '\nGYMBUDDY INDIA | Your consistency partner. Your pocket trainer. | Instagram: @gymbuddy_india',
      ].join('\n');
      await transport.sendMail({
        from: smtp.from,
        to,
        replyTo: senderEmail || undefined,
        subject: title ? `${title} – files from ${senderEmail || appName}` : `${senderEmail || appName} sent you files`,
        text,
      });
    },
  };
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  let v = n;
  do { v /= 1024; i++; } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(v < 10 ? 2 : 1)} ${units[i]}`;
}
