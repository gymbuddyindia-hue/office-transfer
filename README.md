# BuddyBeam

GymBuddy India's own file transfer, for everything WhatsApp will not send (anything over 2 GB). A self-hosted file transfer tool with the WeTransfer workflow: add files, get a
link, share it. No account, no ads, no size cap beyond your own disk.

## What you get that WeTransfer free does not

| | WeTransfer free | BuddyBeam |
|---|---|---|
| Size per transfer | 2 GB | Your disk |
| Link expiry | 7 days, fixed | 1 day to 90 days, or never |
| Password on links | No | Yes |
| Resume after Wi-Fi drop | No | Yes, chunked and resumable |
| Folder upload | No | Yes, keeps the folder structure |
| Delete a sent transfer | No | Yes, from the browser that sent it |
| Download counter | No | Yes |
| QR code for the link | No | Yes |
| Where files live | WeTransfer's cloud | Your own machine, or your own R2 bucket |

## Honest limits

Free and unlimited together only hold on hardware you already own: an office
PC, a NAS, or a VPS with a mounted volume. The free cloud setup below is free
but not unlimited, since it rides on Cloudflare R2's 10 GB free storage.

Email notifications work only if you give it an SMTP account. Without one,
the sender copies the link and sends it on WhatsApp or email themselves.

## Run it with Docker (recommended)

```bash
cd office-transfer   # the clone directory
cp .env.example .env        # edit UPLOAD_CODE at minimum
docker compose up -d --build
```

Open http://<that machine's IP>:3000 from any browser on the office network.
Files are stored in `./data` next to the compose file. Back that folder up or
mount it from your biggest disk.

## Free cloud setup: Render free + Cloudflare R2 free

This is the zero-cost way to run it on the internet with no office PC. The
server runs on a Render free instance and every file lives in a Cloudflare R2
bucket, so nothing is lost when the free instance restarts.

What the free tiers give you, as of this writing:

| | Limit |
|---|---|
| R2 storage | 10 GB stored at any one time, then about 0.015 USD per GB per month |
| R2 downloads | Free, no egress charge |
| Render free instance | 750 hours a month, sleeps after 15 minutes idle, 512 MB RAM |
| Render bandwidth | 100 GB a month outbound; single-file downloads bypass Render entirely |

With a 7 day expiry the 10 GB is a rolling window, so an office sharing a few
GB a week stays free. The first visit after the instance sleeps takes about a
minute to wake. Uploads are capped only by the 10 GB bucket.

Steps:

1. Cloudflare dashboard, R2, create a bucket named `office-transfer`. Keep
   the default location.
2. On the bucket, Settings, add a lifecycle rule that aborts incomplete
   multipart uploads after 2 days, so interrupted uploads never count against
   storage.
3. R2, Manage R2 API tokens, create a token with Object Read and Write on that
   bucket. Note the Access Key ID, Secret Access Key, and the S3 endpoint,
   which looks like `https://<account-id>.r2.cloudflarestorage.com`.
4. Render dashboard, New, Blueprint, pick this repository. It reads
   `render.yaml` and creates one free web service.
5. On the service, Environment tab, fill `S3_ENDPOINT`, `S3_BUCKET`,
   `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, and set `BASE_URL` to the
   service's `onrender.com` address. Read `UPLOAD_CODE` from the same tab and
   give it to staff.
6. Open the service URL.

The same `STORAGE=s3` settings work with Backblaze B2 (10 GB free) and MinIO.

## Paid upgrade on Render

If 10 GB is not enough, either pay R2 per GB (it is cheap) or switch the
blueprint to `plan: starter` with a `disk:` block and `STORAGE=local`.

## Run it without Docker

Needs Node.js 22.13 or newer.

```bash
cd office-transfer   # the clone directory
npm install
cp .env.example .env
set -a; source .env; set +a      # or set the variables another way
npm start
```

On Windows PowerShell, set variables with `$env:UPLOAD_CODE="..."` before
`npm start`.

## Free public address with Cloudflare Tunnel

The office PC stays behind the router. A Cloudflare Tunnel gives it a public
HTTPS address for free, with no port forwarding and no static IP.

1. Create a free Cloudflare account and add a domain you own, or use a
   domain registered through Cloudflare. A domain is the only thing that may
   cost money, and a cheap one is a few dollars a year.
2. In the Cloudflare dashboard open Zero Trust, then Networks, then Tunnels,
   and create a tunnel. Pick the Docker connector and copy the token.
3. Add a public hostname to the tunnel, for example
   `transfer.yourdomain.com`, pointing at `http://transfer:3000`.
4. Put the token in `.env` as `TUNNEL_TOKEN=...` and set
   `BASE_URL=https://transfer.yourdomain.com` so links use the public address.
5. Start both containers:

```bash
docker compose -f docker-compose.yml -f docker-compose.tunnel.yml up -d --build
```

Cloudflare's free plan caps a single request body at 100 MB. Uploads are
8 MB chunks, so that cap never applies. Downloads are not capped.

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
already has. When all chunks are present the server joins them in the
background, checks the byte count, and marks the transfer ready while the
browser polls. That keeps a 50 GB transfer from being cut off by a reverse
proxy's request timeout during the join step. Unfinished uploads are deleted
after 24 hours. Expired transfers are deleted within 10 minutes of expiry.

Password protected transfers never put the password in the URL. The download
page exchanges the password for a signed 12 hour token.

## Verified at size

A 5 GB file was pushed through the real server in testing: 640 chunks of
8 MB with 4 in parallel, background join, single download with a matching
SHA-256, and a zip download that passed a full CRC check. Server memory stayed
under 135 MB throughout, so size is bounded by disk, not RAM.

## Tests

```bash
npm test
```

Runs API integration tests on a temporary data directory and, when
`playwright-core` and a Chromium binary are available, a real browser test
that uploads with a deliberately dropped chunk, unlocks with a password,
downloads, and deletes.
