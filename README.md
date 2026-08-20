# Pho Ha Noi

[![CI](https://github.com/nolanle-gmail/pho-ha-noi/actions/workflows/ci.yml/badge.svg)](https://github.com/nolanle-gmail/pho-ha-noi/actions/workflows/ci.yml)
[![Deploy to Fly](https://github.com/nolanle-gmail/pho-ha-noi/actions/workflows/fly-deploy.yml/badge.svg)](https://github.com/nolanle-gmail/pho-ha-noi/actions/workflows/fly-deploy.yml)

Two standalone restaurant apps for **Pho Ha Noi** (owner: **Harry Nguyen**), built
in the same stack as the reference design in `C:\Restaurant_Design`
(Node.js + Express + built-in `node:sqlite`, vanilla-JS frontend — no build step).

```
PhoHaNoi/
├── management-app/  Enterprise Restaurant Management System — shell + inventory (port 4001)
└── waitlist-app/    Host check-in / waiting list (port 4002)
```

> 📘 **[Platform Handbook](docs/HANDBOOK.md)** — the whole system in one place:
> architecture, the full back-end database design (ER diagrams + a 48-table
> catalog), workflows, the access-level model, and a role-by-role **user guide
> with a per-store test plan and demo logins**. Start here to test with staff.
> Module-level reference for the management app lives in [docs/FEATURES.md](docs/FEATURES.md).

## 🚀 Try it live

Both apps are deployed on Fly.io — sign in with the demo accounts and explore.

| App | URL | Demo login |
|-----|-----|------------|
| **Management** (staff) | **https://pho-ha-noi-management.fly.dev** | `harry@phohanoi.com` / `Harry123!` (owner) |
| **Waitlist** (front desk) | **https://pho-ha-noi-waitlist.fly.dev** | `host1@phohanoi.com` / `Host123!` |
| **Customer self check-in** (no login) | **https://pho-ha-noi-waitlist.fly.dev/checkin** | — just walk up and join |

Explore the **access levels** on the management app with these logins (all
password-per-name below): owner `harry@phohanoi.com` / `Harry123!` · general
manager `gm@phohanoi.com` / `Gm123456!` · analyst `analyst@phohanoi.com` /
`Analyst123!` · driver `driver@phohanoi.com` / `Driver123!` · server
`server@phohanoi.com` / `Server123!` · manager `manager1@phohanoi.com` /
`Manager123!` — each sees a different slice of the app.

> ⚠️ **Shared demo sandbox.** Anyone can sign in and edit the data, so please don't
> enter real information. The machines idle-sleep to save cost and cold-start in
> ~1–2 s on the first request.

## 1. Enterprise Restaurant Management System  (`management-app`, http://localhost:4001)

**Management shell** — a left vertical sidebar (Overview · Locations · Staff ·
Inventory · Central Kitchen · Menu/Recipes · Reports · Messages) plus **Account
Settings** (profile + change password). Sidebar items are filtered by access
level. **Managers get a dedicated dashboard** as their Overview: a greeting +
today's date, KPI tiles (staff, on-shift today, anyone over 40h this week, low
stock, equipment issues, unread messages), **today's roster** (each person's
shift, hours, assigned-job count, and OT flags — with an "away" mark when they're
at another store), **weekly schedule health** (unfilled days the store is open
but nobody's scheduled, staff-days over 8h, over-40h staff, shifts missing jobs,
unscheduled staff), **roster status** (active /
vacation / sick / inactive), and a **needs-attention** panel (below-par stock +
equipment needing service). Every tile links into the relevant module. Several
sections have their own horizontal tab bars:
- **Inventory** — Dashboard · Stock · Orders & Reorder · Transfers · Lots & Expiry
  · Vendors · Reports · Activity · Glossary.
- **Central Kitchen** (owner/admin) — the production & supply hub for all stores:
  **Demand** (aggregates daily item requests from every location — with a
  **Generate from sales** action that rebuilds requests from each store's 7-day
  average covers × per-cover usage), **Production** (master recipes scaled into
  batch sheets with yield/shrinkage control + safety-stock alerts; record runs to
  update on-hand), **Recipes** (a **master-recipe editor** — add/edit products
  and their batch yield, shrinkage, safety stock, and per-batch ingredients drawn
  from real inventory costs), **Fulfillment** (consolidated pick-list, per-store
  packing slips, and delivery-route manifests — fulfilling a store **delivers the
  produced stock into that store's own inventory** as a logged *in* transfer),
  and **CK Staff** (roster, photo-verified task assignments, shift schedule, and a
  **PIN time-clock** terminal). The Central Kitchen is a special `central_kitchen`
  location (in the Locations directory but hidden from store switchers).
- **Menu/Recipes** — **Menu** (items + categories, CRUD), **Recipes** (link each
  item to inventory ingredients per serving; live recipe cost / food-cost % /
  margin), **Costing** (all items with food-cost % vs a ≤30 / 30–40 / >40 target).
  Costs come from each ingredient's average inventory unit cost, so the menu is
  wired to real stock prices.
- **Staff** — **Overview** (per-location roster health: staff count, the
  location's manager, and an active / vacation / sick / inactive breakdown, with
  KPI totals across all stores), **Directory**, **Jobs / Tasks**, and **Access
  Levels** (reference matrix of what each level can do).
  - **Jobs / Tasks** — a catalog of the jobs that exist in the restaurant
    (grouped by department: Front of House, Back of House, Bar, Facilities,
    Management), each with a **Job ID**, name, description/instructions,
    **complexity** (low / medium / high), typical duration, and notes. Managers
    and owner/admin curate the shared catalog (add / edit / retire) and pick from
    it when scheduling. Ships with ~25 seeded jobs (Broth Station, Take Orders,
    Expo/Plating, Opening & Closing checklists, Cash Reconciliation, …).
  - **Directory** — a clickable **A–Z letter bar** (defaults to "A" on open;
    letters with no one are dimmed) plus a search that spans every staff member.
    Each row has a **View** button opening the person's full profile; owner/admin
    also get inline Edit / Reset-password / Activate-Deactivate.
  - **Add staff** (owner/admin) — a full form that creates the account *and* its
    complete HR profile in one go, including access level, home location, and
    additional **"also works at"** locations (for cross-location coverage /
    transfers).
  - **Staff profile** — a full HR record per person: personal details, work +
    personal contact, mailing address, emergency contact, employment (**job title**
    — a standard-titles picker (Server, Line Cook, Front Desk, …) that still allows
    free text, and is shown under the name in the directory and in the profile
    header — plus department, type, hire date, supervisor, home + additional
    locations), payroll (pay type + hourly rate), and skills / notes. The view page offers **Edit
    profile**, **Reset password**, and **Activate/Deactivate**. By design, SSN and
    bank/account numbers are **not** stored here — keep those in your payroll
    provider (only a non-sensitive payroll reference is kept).
  - **Guardrails:** only owners create owners, no self-deactivation, unique
    emails.
  - **Activity Log** (owner/admin) — a full access trail: every sign-in (success
    *and* failure with the attempted email + IP), every change (POST/PUT/DELETE),
    and every **denied** attempt (401/403). Filter by Logins / Denied. Read-only
    page views are skipped to avoid noise (set `LOG_READS=1` to capture them).
  - The demo seed ships **10 named store managers** (each with a General-Manager
    profile) plus **150 generated staff** spread across the stores, each with a
    full profile, so the directory and reports are populated out of the box.
- **My Schedule** (manager / support / employee) — a read-only weekly view of the
  signed-in person's own shifts across **every** location they work: seven day
  cards with each shift's time, hours, assigned jobs, and store, a running
  **week total (/40h)**, and the same **overtime flags** as the scheduler — days
  over 8h are marked ⚠ and a banner calls out an over-40h week ("Check with your
  manager"). Only a manager can change a shift.
- **Reports** — **Items** (inventory value by category/location, top items,
  30-day COGS), **Sales** (revenue, covers, avg check, daily + by-location),
  **Analytics** (revenue trend, food-cost %, labor-cost %, best/lowest location),
  **Timesheets** (staff hours + labor cost from hourly rates), **Payments**
  (cash / card / online split by location). Location + date-range filters;
  owner/admin see all locations, managers are scoped to theirs.
- **Messages** — team messaging: **Inbox** (unread badges in the sidebar + tab,
  click to mark read), **Sent** (with read progress), **Compose** (direct to a
  person, or broadcast to all staff / a whole location — broadcasts are
  manager-and-above only). Everyone can send direct messages.
- **Locations** — a directory of every location (+ **add new**, owner/admin) with
  a per-location detail view: **Details** (address, phone, email, seats, opening
  date, manager, plus editable **operating hours**), **Staff** (roster),
  **Schedule**, and **Equipment** (assets with vendor + phone, model/serial,
  purchase & warranty dates, **maintenance schedule** with next-service due dates
  flagged when overdue, and status — operational / needs-service / out-of-order;
  full CRUD). Owner/admin manage everything; managers manage their own location's
  hours, equipment & schedule.
  - **Schedule** — a **weekly staff schedule** the location's manager builds from
    the Manage view: a grid of every staff member at that location × the seven
    days of the week. Click **+** on any day to add a shift (start/end time, notes),
    **pick one or more jobs/tasks** from the catalog, and add **breaks**. Breaks are
    **10 minutes each and paid** (they do *not* reduce worked hours): the manager
    picks only the **start** and the end auto-fills to +10 min. Breaks unlock once
    the shift is **at least 3.5 hours**, and a staff member gets **at most 2 breaks
    per day** (across all their shifts that day) — **unless the day totals more than
    10 hours worked**, in which case there's no per-day limit. Each break must sit
    inside the shift (all enforced client- and server-side). They show as ☕ chips on the grid and
    the staff's My Schedule, with a **per-day total break time** on both the grid
    cell (☕ Nm) and the My Schedule day card. A day can hold **multiple work periods** — e.g.
    8:00–12:00 *and* 12:00–16:00, each with its own break — just click **+** again to
    add another; and a staff member can hold several jobs on a shift. Week navigation (prev / this week / next) and
    a highlighted "today". Because each shift carries its own location, a person
    can be scheduled at **different locations on different days** — shifts at
    another store show as read-only "@ store" cards for cross-location visibility,
    and staff whose home store is elsewhere are flagged **visiting**. Each shift
    shows its hours, and the grid enforces soft limits — **8h/day** and **40h/week**
    (full-time): the day cell and the week total turn red ⚠ when exceeded, and the
    shift editor blocks the save until the scheduler ticks **"Approve overtime
    exception"**, so going over is a deliberate, authorized choice. Standard restaurant equipment (walk-ins, ranges, fryers, ice
  machine, dishwasher, hood/fire suppression, POS, etc.) is seeded per location.

**Access levels:** every access level is defined **once** in a registry
(`lib/auth.js`) as a **scope** (`all` locations / their own `location` / `self`)
plus **capabilities** (org · manage · ops · reports · central · delivery). Route
permission groups *and* the sidebar are both derived from that table, and the
**Staff → Access Levels** page renders straight from it, so adding a level wires
it up everywhere. Shipped levels:

- **Owner / Admin** — everything, all locations (only an Owner can create Owners).
- **General Manager / Regional Manager** — operations across every store.
- **Manager / Assistant Manager / Kitchen Manager** — their own store (staff,
  schedule, inventory, menu, reports, messages).
- **Analyst / Accountant** — read-only Reports & analytics across all locations.
- **Inventory Support** — inventory operations at their location.
- **Driver** — a read-only **Deliveries** view (Central-Kitchen manifests /
  packing slips) + their own schedule + messages.
- **Positions** (Server, Host / Front Desk, Cashier, Bartender, Barista, Busser,
  Chef, Line Cook, Prep Cook, Dishwasher, …) — self-service only: **My Schedule**,
  their assigned tasks, and messages. These are separate access levels that all
  share the same `self` scope — same permissions, different job title.

Enforced in the UI (sidebar + pages) **and** the API (403s); managers get a
location dashboard, and everyone `self`-scoped lands on a personal home screen.

The inventory module is a faithful port of the reference design, with the catalog tailored
to a Vietnamese pho restaurant (49 items across Protein, Noodles, Produce, Pantry,
Spices, Beverage, Packaging, Cleaning) across 10 Bay Area / SoCal locations
(San Jose, Milpitas, Cupertino, Fremont, Palo Alto, Berkeley, Fountain Valley,
Santa Clara, Sunnyvale, Oakland).

**Features**
- **Glossary / item catalog** — every item with description, SKU, category, unit, notes; add / edit / remove items (remove is a soft-delete that preserves history)
- Per-location stock with SKU, category, unit, **min (reorder trigger)** and **par (target)** levels, rolling unit cost
- **Create order (PO)** from a dropdown of existing items **or add a brand-new item inline** before ordering; also **order straight from the Stock page** (button revealed on row hover, pre-filled with the item's details + a build-to-par suggested quantity)
- **Receiving** (by item or SKU) that records dated **lots**; **FIFO** consumption by earliest expiry
- **Lots & expiry** tracking — expiring-soon / expired views, discard-to-waste
- **Waste / spoilage** logging and **cycle counts** (system-vs-counted variance)
- **Vendors** master list + **purchase/supply orders** with a full lifecycle (pending → approved → shipped → received; receiving adds stock)
- **Auto-reorder suggestions** (items below par → suggested build-to-par qty + est. cost) → one-click PO
- **Transfers** between locations, immutable **transaction ledger**
- **Activity log** — every order, status change, reorder, transfer and receive is recorded with **who did it** (name + role) and when
- **Reports**: inventory valuation by category + 30-day consumed cost (COGS)
- Access levels: a registry-driven RBAC model — Owner/Admin, General/Regional/Assistant/Kitchen Manager, Analyst/Accountant, Inventory Support, Driver, and self-service positions (Server, Chef, Front Desk, …) — with per-capability gating + location scoping

**Logins:** `harry@phohanoi.com` / `Harry123!` (owner) · `admin@phohanoi.com` / `Admin123!` · `manager1@phohanoi.com` / `Manager123!` · `support@phohanoi.com` / `Support123!` · `employee@phohanoi.com` / `Employee123!`
Additional access levels: `gm@phohanoi.com` / `Gm123456!` (general manager) · `analyst@phohanoi.com` / `Analyst123!` · `driver@phohanoi.com` / `Driver123!` · `server@phohanoi.com` / `Server123!` · `chef@phohanoi.com` / `Chef123456!`

## 2. Waiting-list app  (`waitlist-app`, http://localhost:4002)

A touch-friendly host station for walk-in check-in and paging, with **two ways to
join the list**:

- **Customer self check-in** — a public, no-login page at **`/checkin`**. Give each
  store its own kiosk URL with a **location slug** — `/checkin/berkeley` (or
  `/checkin?loc=<id>`) — so a lobby tablet / QR shows **only that store's** waitlist;
  the device also **remembers its store** so a bare `/checkin` stays put. The guest sees
  the current wait, enters name / party size / phone and any **special requests**
  (tap-to-add chips — high chair, booster, bar seat, booth, wheelchair accessible,
  patio, birthday — plus a free-text box for allergies/occasions), joins the list,
  and then **tracks their spot live** by reference code — the screen updates to "🔔 Your
  table is ready!" the moment the host pages them, and "🎉 You're seated!" when
  they're seated. These land on the board tagged **SELF CHECK-IN**.
- **Front-desk entry** — the authenticated host station (below), **scoped to the
  signed-in host's store** (shown as a 📍 badge in the header; owners get a store
  switcher that remembers their last pick), where staff add parties themselves
  (phone-ins or walk-ins they're helping) and **manage the whole list**: notify, seat, and remove parties, plus stats, history and reports.
  Special requests entered at check-in show inline on each party card.

**Front-desk features**
- Live queue with per-party waited time and quoted wait; self-check-ins flagged
- **Add party** (name, size stepper, phone, auto-suggested quote = parties ahead × avg turn)
- **Notify/page** guest their table is ready (SMS stubbed → logged to `notify_log`)
- **Seat** (with table number) / mark **Left**
- Live stats: waiting now, longest wait, next-party quote, seated today
- "Handled today" history; auto-refreshes every 15s
- **Activity log** — every add / notify / seat / remove is recorded with **who did it** (name + role) and shown in a "who did what" log
- **Access / Activity Log (owner only)** — a full trail of sign-ins (incl. failed attempts + IP), staff actions, **customer self check-ins**, and denied attempts, filterable by Logins / Check-ins / Denied
- **Guest history (owner/admin only)** — full history of every guest at any point in time, across all 10 locations, filterable by location, date range and status; **one-click CSV export** of the filtered results
- **Daily report (owner/admin only)** — guests and parties on the waitlist per day (with seated/left breakdown), for one location or all 10
- Owner can view any location's live board at any time via the location switcher
- Roles: owner · manager · frontdesk (host) — location-scoped; history/report are owner-only

**Logins (front desk):** `host1@phohanoi.com` / `Host123!` (host) · `harry@phohanoi.com` / `Harry123!` (owner, all locations). **Customer self check-in** needs no login: open **`/checkin`**.

**Public-endpoint hardening:** the no-login check-in surface is protected without any
extra dependencies — a per-IP rate limit on `POST /api/public/checkin` (default 20 /
10 min) plus a generous backstop across all public routes, a duplicate-submit guard
(a double-tap / reload returns the same entry instead of a new one), and a 16 KB body
cap. Tune per deployment with env vars — `CHECKIN_MAX`, `CHECKIN_WINDOW_MS`,
`PUBLIC_MAX` — and set **`TRUST_PROXY`** (e.g. `1`) when running behind Caddy / nginx
so the limiter sees real client IPs.

## Run either app

```bash
cd management-app   # or waitlist-app
npm install
npm run seed       # demo data
npm start
```

Requires **Node 22+** (uses the built-in `node:sqlite`; Node 24 recommended).

## Tests

Each app has an end-to-end smoke test hitting its real API:

```bash
npm run smoke      # management: 153 checks · waitlist: 46 checks
```

## Docs

[docs/HANDBOOK.md](docs/HANDBOOK.md) carries a `_Last updated: …_` stamp that
**refreshes itself** on commit. Enable the git hook once per clone:

```bash
git config core.hooksPath .githooks
```

After that, any commit touching the handbook re-stamps today's date (via
`scripts/stamp-handbook.mjs`). Run the script by hand to stamp the artifact HTML
before republishing: `node scripts/stamp-handbook.mjs <handbook.html>`.
