# Deploying the Waitlist app to Fly.io

The waitlist app is a single long-running Node process that stores everything in a
**SQLite file**. On Fly that means: one machine, one persistent **volume**, and a
few environment secrets. Files in this folder do the heavy lifting:

- `Dockerfile` — Node 24 image (built-in `node:sqlite`, no native build step)
- `fly.toml` — app config, `/data` volume mount, HTTPS, `/health` check
- `.dockerignore` — keeps the local dev DB and `node_modules` out of the image

## 1. One-time setup

```bash
# Install the CLI (macOS: brew install flyctl · Windows: iwr https://fly.io/install.ps1 -useb | iex)
fly auth signup      # or: fly auth login
```

## 2. Create the app + volume

Run everything from **this directory** (`waitlist-app/`).

```bash
# Pick a globally-unique name and set it as `app = "..."` in fly.toml first, then:
fly apps create pho-ha-noi-waitlist

# 1 GB persistent disk in the same region as the app (holds the SQLite DB).
fly volumes create phn_waitlist_data --region sjc --size 1
```

## 3. Set secrets

```bash
# A strong signing key for JWT sessions (never commit this).
fly secrets set JWT_SECRET=$(openssl rand -hex 32)

# Optional — tune the public check-in abuse limits per your traffic:
# fly secrets set CHECKIN_MAX=30 PUBLIC_MAX=800
```

## 4. Deploy

```bash
fly deploy
fly scale count 1     # SQLite needs a single machine (one writer, one disk)
```

## 5. Seed the database once

A fresh volume is empty, and the app needs **locations** (and at least one host
account) to work. Seed it a single time, then harden the accounts:

```bash
fly ssh console -C "node /app/db/seed.js"
```

> ⚠️ `seed.js` **wipes and recreates** demo data every run — only run it on first
> setup. It creates the 10 locations plus demo logins (`host1@phohanoi.com` /
> `Host123!`, `harry@phohanoi.com` / `Harry123!`). **Immediately sign in and change
> those passwords**, or replace the seed with your real locations/staff.

## 6. Open it

```bash
fly open              # front desk (host sign-in)
fly open /checkin     # customer self check-in kiosk (public)
```

Point a per-store QR code at `https://<your-app>.fly.dev/checkin?loc=<id>`.

## Backups

The whole database is one file on the volume. Snapshot the volume regularly:

```bash
fly volumes list                       # find the volume id
fly volumes snapshots list <vol-id>    # Fly also auto-snapshots daily (5-day retention)
```

To pull a copy locally: `fly ssh console -C "cat /data/phohanoi_waitlist.db" > backup.db` (or use `fly sftp get`).

## Auto-deploy on push (GitHub Actions)

`.github/workflows/fly-deploy.yml` deploys each app to Fly when its files change on
`main` — after the smoke suite passes, and only for the app that changed. To enable
it, add a Fly deploy token as a repo secret:

```bash
fly tokens create org        # one token that can reach both apps
# GitHub → Settings → Secrets and variables → Actions → New repository secret
#   Name: FLY_API_TOKEN   Value: <the token>
```

Until that secret exists the workflow still runs and passes — it just skips the
deploy step — so it won't show red before you're set up. You can also trigger it
manually from the Actions tab (**Run workflow**).

## Notes & gotchas

- **Single machine only.** The volume attaches to one machine; `fly scale count 1`
  keeps writes consistent. Don't scale out.
- **Custom domain / TLS:** `fly certs add waitlist.yourdomain.com`, then add the
  DNS records Fly prints. HTTPS is automatic.
- **Node version:** the image pins Node 24 (built-in `node:sqlite`); don't drop below
  Node 22.5.
- **Redeploys** keep the volume, so your data survives `fly deploy`.
- The **management app** deploys the same way — copy this `Dockerfile` / `fly.toml`
  into `management-app/`, change the app name, DB filename, and volume, and repeat.
