# Custom subdomains (Fly.io)

Point your own domain at the two Fly apps. This is a **DNS + certificate** task —
it runs against your registrar and your deployed Fly apps, so do it *after* each
app is created and deployed (see each app's `DEPLOY.md`).

Replace `example.com` with your domain throughout. Recommended scheme:

| App | Subdomain | Notes |
|-----|-----------|-------|
| Management (staff) | `admin.example.com` | Internal — staff sign-in |
| Waitlist (front desk) | `waitlist.example.com` | Host station |
| Waitlist customer kiosk | `waitlist.example.com/checkin` | Same app, public path — no separate domain needed |

> The customer kiosk is just a **path** on the waitlist app, so one subdomain covers
> both the front desk and the QR/kiosk (`waitlist.example.com/checkin?loc=<id>`).

## 1. Tell Fly about each subdomain

```bash
# from management-app/
fly certs add admin.example.com

# from waitlist-app/
fly certs add waitlist.example.com
```

Each command prints the **exact DNS records** to create. For a subdomain the simplest
is a single CNAME to the app's Fly hostname:

```
Type   Name        Value
CNAME  admin       pho-ha-noi-management.fly.dev
CNAME  waitlist    pho-ha-noi-waitlist.fly.dev
```

(Use whatever hostnames Fly prints — they match your `app = "…"` names. If Fly asks
for an `_acme-challenge` CNAME as well, add that too.)

## 2. Add the records at your DNS provider

In your registrar / DNS host (Cloudflare, Namecheap, Route 53, …) create the CNAME(s)
above. If you use **Cloudflare**, set the record to **DNS only** (grey cloud) so Fly
can issue and terminate TLS directly.

## 3. Wait for the certificate, then verify

```bash
fly certs check admin.example.com      # from management-app/
fly certs check waitlist.example.com   # from waitlist-app/
```

Fly issues a free Let's Encrypt cert automatically once DNS resolves (usually a few
minutes). HTTPS is already forced in each `fly.toml` (`force_https = true`), so once
the cert is `Ready`:

- Management → `https://admin.example.com`
- Waitlist front desk → `https://waitlist.example.com`
- Customer kiosk / QR → `https://waitlist.example.com/checkin?loc=<id>`

## Apex domain (optional)

To use a bare `example.com` (no subdomain) instead of a CNAME, point A/AAAA records at
the app's dedicated IPs:

```bash
fly ips list          # shows the app's IPv4 (A) and IPv6 (AAAA)
fly certs add example.com
```

Then create `A → <ipv4>` and `AAAA → <ipv6>` records at the apex.

## Notes

- Each app is a **separate Fly app**, so run its `fly certs …` commands from that
  app's folder (or pass `-a <app-name>`).
- Certs auto-renew — nothing to maintain.
- `fly certs show <domain>` re-prints the required records if you need them again.
