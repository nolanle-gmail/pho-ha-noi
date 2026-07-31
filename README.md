# Pho Ha Noi

Two standalone restaurant apps for **Pho Ha Noi** (owner: **Harry Nguyen**), built
in the same stack as the reference design in `C:\Restaurant_Design`
(Node.js + Express + built-in `node:sqlite`, vanilla-JS frontend — no build step).

```
PhoHaNoi/
├── inventory-app/   Full inventory management (port 4001)
└── waitlist-app/    Host check-in / waiting list (port 4002)
```

## 1. Inventory app  (`inventory-app`, http://localhost:4001)

A faithful port of the reference inventory design, with the item catalog tailored
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
- Roles: owner (all locations) · manager · stockroom · chef — RBAC + location scoping

**Logins:** `harry@phohanoi.com` / `Harry123!` (owner) · `manager1@phohanoi.com` / `Manager123!` · `stock@phohanoi.com` / `Stock123!`

## 2. Waiting-list app  (`waitlist-app`, http://localhost:4002)

A touch-friendly host station for walk-in check-in and paging.

**Features**
- Live queue with per-party waited time and quoted wait
- **Add party** (name, size stepper, phone, auto-suggested quote = parties ahead × avg turn)
- **Notify/page** guest their table is ready (SMS stubbed → logged to `notify_log`)
- **Seat** (with table number) / mark **Left**
- Live stats: waiting now, longest wait, next-party quote, seated today
- "Handled today" history; auto-refreshes every 15s
- **Activity log** — every add / notify / seat / remove is recorded with **who did it** (name + role) and shown in a "who did what" log
- **Guest history (owner/admin only)** — full history of every guest at any point in time, across all 10 locations, filterable by location, date range and status; **one-click CSV export** of the filtered results
- **Daily report (owner/admin only)** — guests and parties on the waitlist per day (with seated/left breakdown), for one location or all 10
- Owner can view any location's live board at any time via the location switcher
- Roles: owner · manager · frontdesk (host) — location-scoped; history/report are owner-only

**Logins:** `host1@phohanoi.com` / `Host123!` (host) · `harry@phohanoi.com` / `Harry123!` (owner, all locations)

## Run either app

```bash
cd inventory-app   # or waitlist-app
npm install
npm run seed       # demo data
npm start
```

Requires **Node 22+** (uses the built-in `node:sqlite`; Node 24 recommended).

## Tests

Each app has an end-to-end smoke test hitting its real API:

```bash
npm run smoke      # inventory: 38 checks · waitlist: 21 checks
```
