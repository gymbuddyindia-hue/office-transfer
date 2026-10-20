# Office Transfer

A self-hosted file transfer tool with the WeTransfer workflow: add files, get a
link, share it. No account, no ads, no size cap beyond your own disk.

## What you get that WeTransfer free does not

| | WeTransfer free | Office Transfer |
|---|---|---|
| Size per transfer | 2 GB | Your disk |
| Link expiry | 7 days, fixed | 1 day to 90 days, or never |
| Password on links | No | Yes |
| Resume after Wi-Fi drop | No | Yes, chunked and resumable |
| Folder upload | No | Yes, keeps the folder structure |
| Delete a sent transfer | No | Yes, from the browser that sent it |
| Download counter | No | Yes |
| QR code for the link | No | Yes |
| Where files live | WeTransfer's cloud | Your own machine |

## Honest limits

Free and unlimited only hold because the files sit on hardware you already
own. A free cloud tier without a persistent disk (Render free, Vercel,
Netlify) deletes everything on restart and is not a supported way to run this.
Run it on an office PC, a NAS, or a VPS with a mounted volume.

Email notifications work only if you give it an SMTP account. Without one,
the sender copies the link and sends it on WhatsApp or email themselves.

## Run it with Docker (recommended)

```bash
cd office-transfer
cp .env.example .env        # edit UPLOAD_CODE at minimum
docker compose up -d --build
```

Open http://<that machine's IP>:3000 from any browser on the office network.
Files are stored in `./data` next to the compose file. Back that folder up or
mount it from your biggest disk.

## Run it without Docker

Needs Node.js 22.13 or newer.

```bash
cd office-transfer
npm install
cp .env.example .env
set -a; source .env; set +a      # or set the variables another way
npm start
```

On Windows PowerShell, set variables with `$env:UPLOAD_CODE="..."` before
`npm start`.

## Exposing it outside the office

Put it behind a reverse proxy with HTTPS (Caddy is the least effort) and set
`BASE_URL` to the public address so links and emails use it. Keep
`UPLOAD_CODE` set so outsiders cannot fill your disk. Downloads need no code,
only the link, which is a 22 character random id. Add a password per transfer
for anything sensitive.

Caddyfile example:

```
transfer.yourcompany.com {
    reverse_proxy 127.0.0.1:3000
    request_body {
        max_size 0
    }
}
```

With nginx, set `client_max_body_size 0;` and
`proxy_request_buffering off;` on the location, or large uploads will fail.

## Settings

See `.env.example`. Every value has a default and the app runs with none set.

## How uploads work

The browser splits each file into 8 MB chunks and uploads four at a time.
Each chunk is retried up to five times with backoff. If the page is closed
mid-upload, adding the same files again resumes from the chunks the server
already has. When all chunks are present the server joins them, checks the
byte count, and marks the transfer ready. Unfinished uploads are deleted
after 24 hours. Expired transfers are deleted within 10 minutes of expiry.

Password protected transfers never put the password in the URL. The download
page exchanges the password for a signed 12 hour token.

## Tests

```bash
npm test
```

Runs API integration tests on a temporary data directory and, when
`playwright-core` and a Chromium binary are available, a real browser test
that uploads with a deliberately dropped chunk, unlocks with a password,
downloads, and deletes.
