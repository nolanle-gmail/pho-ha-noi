# Deploying the Management app to Fly.io

The management app is a single long-running Node process that stores everything in
a **SQLite file**. On Fly that means: one machine, one persistent **volume**, and a
few environment secrets. Files in this folder do the heavy lifting:

- `Dockerfile` — Node 24 image (built-in `node:sqlite`, no native build step)
- `fly.toml` — app config, `/data` volume mount, HTTPS, `/health` check
- `.dockerignore` — keeps the local dev DB and `node_modules` out of the image

> This is the **internal, staff-only** app (no public/anonymous routes). Only put it
> online if your team needs remote access; otherwise keep it on the LAN.

## 1. One-time setup

```bash
# Install the CLI (macOS: brew install flyctl · Windows: iwr https://fly.io/install.ps1 -useb | iex)
fly auth signup      # or: fly auth login
```

## 2. Create the app + volume

Run everything from **this directory** (`management-app/`).

```bash
# Pick a globally-unique name and set it as `app = "..."` in fly.toml first, then:
fly apps create pho-ha-noi-management

# 1 GB persistent disk in the same region as the app (holds the SQLite DB).
fly volumes create phn_management_data --region sjc --size 1
```

## 3. Set secrets

```bash
# A strong signing key for JWT sessions (never commit this).
fly secrets set JWT_SECRET=$(openssl rand -hex 32)
```

## 4. Deploy

```bash
fly deploy
fly scale count 1     # SQLite needs a single machine (one writer, one disk)
```

## 5. Seed the database once

A fresh volume is empty, and the app needs **locations, staff, inventory, menu,**
etc. to be useful. Seed it a single time, then harden the accounts:

```bash
fly ssh console -C "node /app/db/seed.js"
```

> ⚠️ `seed.js` **wipes and recreates** demo data every run — only run it on first
> setup. It creates the 10 locations, the full catalog, and demo logins
> (`harry@phohanoi.com` / `Harry123!` owner, plus admin / managers / gm / analyst /
> driver / positions). **Immediately sign in and change those passwords**, or replace
> the seed with your real data.

## 6. Open it

```bash
fly open
```

## Backups

The whole database is one file on the volume. Snapshot the volume regularly:

```bash
fly volumes list                       # find the volume id
fly volumes snapshots list <vol-id>    # Fly also auto-snapshots daily (5-day retention)
```

To pull a copy locally: `fly ssh console -C "cat /data/phohanoi_management.db" > backup.db` (or use `fly sftp get`).

## Notes & gotchas

- **Single machine only.** The volume attaches to one machine; `fly scale count 1`
  keeps writes consistent. Don't scale out.
- **Custom domain / TLS:** `fly certs add admin.yourdomain.com`, then add the DNS
  records Fly prints. HTTPS is automatic.
- **Node version:** the image pins Node 24 (built-in `node:sqlite`); don't drop below
  Node 22.5.
- **Redeploys** keep the volume, so your data survives `fly deploy`.
- This is a **separate Fly app** from the waitlist — its own name, volume, and
  secrets. Deploy each from its own folder.
