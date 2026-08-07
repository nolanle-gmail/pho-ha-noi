# Pho Ha Noi Management System — Functions & Features

A complete reference of every module, function, and feature in the **Pho Ha Noi
Management System** (`management-app`), the multi-location back-office platform
for the Pho Ha Noi restaurant group (owner: **Harry Nguyen**).

> This document covers the management app only. The separate host **Waiting-list
> app** (`waitlist-app`, port 4002) is documented in the top-level
> [README](../README.md).

---

## 1. At a glance

| | |
|---|---|
| **Stack** | Node.js + Express, built-in `node:sqlite` (`DatabaseSync`), vanilla-JS single-page frontend — no build step |
| **Runtime** | Node 22+ (Node 24 recommended) |
| **Server** | `http://localhost:4001` |
| **Auth** | JWT (12-hour tokens), bcrypt password hashes |
| **Frontend** | One SPA (`public/app.js`) with a left sidebar + per-module horizontal tabs |
| **API** | REST under `/api/*`, all responses JSON |
| **Tests** | `npm run smoke` — 120 end-to-end checks against the live API |

**Seeded demo data:** 10 restaurant locations + 1 central kitchen (11 total),
17 staff accounts, 49 distinct inventory items across 8 categories, 4 vendors,
11 menu items in 4 categories with 60 recipe links, 125 pieces of equipment,
300 days of sales history, and 7 central-kitchen products with master recipes.

---

## 2. Access levels (RBAC)

Five named access levels map onto four permission tiers. Every API route is
guarded by a tier, and the sidebar/pages hide what a level cannot use. The API
is the source of truth — it returns **403** on any disallowed action, so UI
hiding is convenience, not the security boundary.

| Level | Tier | Scope | Can do |
|---|---|---|---|
| **Owner** | ADMIN | All locations | Everything, including creating owners |
| **Admin** | ADMIN | All locations | Everything except is itself created by an owner |
| **Manager** | MANAGE | Own location | Runs their location: menu, vendors, POs, hours, equipment, reports (scoped) |
| **Support** | OPS | Own location | Stock operations: receive, transfer, count, waste, orders |
| **Employee** | ALL | Own location | View + request only (create orders/transfer requests) |

**Permission tiers** (from `lib/auth.js`):

- **ALL** — any signed-in user (`owner, admin, manager, support, employee`)
- **OPS** — stock operations (`owner, admin, manager, support`)
- **MANAGE** — items, vendors, POs, menu, reports, locations (`owner, admin, manager`)
- **ADMIN** — users, settings, new locations, Central Kitchen (`owner, admin`)

**Location scoping:** owners and admins see and switch between all locations via
the location picker; managers/support/employees are pinned to their assigned
location.

---

## 3. Authentication & Account

| Function | Description | Endpoint |
|---|---|---|
| **Login** | Email + password → JWT (stored in `localStorage`) | `POST /api/auth/login` |
| **Session identity** | Returns the current user (name, role, location) | `GET /api/auth/me` |
| **Change password** | Verifies current password, updates hash | `POST /api/auth/change-password` |
| **Sign out** | Clears local session | client-side |

**Account Settings** screen (sidebar footer): view profile (name, email, role,
location) and change password.

---

## 4. Application shell

- **Left sidebar** — module navigation, filtered by access level, with live
  unread-message badges. Collapses to a hamburger drawer on narrow screens.
- **Top bar** — page title, location picker (owner/admin), signed-in user chip.
- **Per-module tab bars** — Inventory, Central Kitchen, Menu/Recipes, Reports,
  and Messages each have their own horizontal sub-tabs.
- **Modals & toasts** — shared helpers for create/edit dialogs and confirmations.

Sidebar modules: **Overview · Locations · Staff · Inventory · Central Kitchen ·
Menu/Recipes · Reports · Messages** + **Account Settings**.

---

## 5. Modules

### 5.1 Overview  *(all levels)*

Landing dashboard with headline KPIs and quick links into the other modules.

### 5.2 Locations  *(owner, admin, manager)*

A directory of every location with a per-location detail view.

**Functions**
- **Directory list** — all locations with manager name and staff count.
- **Add location** *(owner/admin)* — name, address, contact, seats, opening date.
- **Details tab** — address, phone, email, seats, opening date, assigned manager,
  plus **editable operating hours** (per-day open/close, closed flag).
- **Staff tab** — roster assigned to the location.
- **Equipment tab** — full asset register per location:
  - Vendor name + phone, model/serial, purchase & warranty dates
  - **Maintenance schedule** with next-service due dates, flagged when overdue
  - Status: operational / needs-service / out-of-order
  - Full CRUD (add / edit / delete)
- **Standard equipment** seeded per location (walk-ins, ranges, fryers, ice
  machine, dishwasher, hood/fire suppression, POS, etc.).

**Access:** owner/admin manage everything; managers manage their own location's
hours & equipment.

**Endpoints:** `GET /api/locations`, `GET /:id`, `GET /:id/staff`,
`POST /` *(admin)*, `PUT /:id` *(admin)*, `PUT /:id/hours`,
`GET/POST /:id/equipment`, `PUT/DELETE /equipment/:eid`.

### 5.3 Staff  *(owner, admin, manager)*

**Directory tab**
- Add / edit / deactivate staff; assign access level + home location
- Reset a staff member's password
- Guardrails: only owners can create owners; no self-deactivation; unique emails
- Managers have view-only access

**Access Levels tab** — a reference matrix of what each level can do.

**Endpoints:** `GET /api/staff`, `POST /api/staff` *(admin)*,
`PUT /api/staff/:id` *(admin)*, `POST /api/staff/:id/reset-password` *(admin)*.

### 5.4 Inventory  *(all levels; write actions = OPS/MANAGE)*

A faithful port of the reference inventory design, tailored to a Vietnamese pho
catalog (49 items across Protein, Noodles, Produce, Pantry, Spices, Beverage,
Packaging, Cleaning) across all 10 stores. Nine tabs:

**Dashboard** — per-location stock health: totals, low-stock and expiring counts.

**Stock** — per-location item list with SKU, category, unit, quantity, **min
(reorder trigger)** and **par (target)** levels, and a rolling unit cost.
- **Order-on-hover** — a button appears on each row to raise a PO pre-filled with
  the item's details and a build-to-par suggested quantity.
- Edit item, adjust levels, soft-delete (preserves history).

**Orders & Reorder**
- **Create order (PO)** from a dropdown of existing items, **or add a brand-new
  item inline** before ordering.
- **Auto-reorder suggestions** — items below par with a suggested build-to-par
  quantity + estimated cost → one-click PO.
- **Supply-order lifecycle** — pending → approved → shipped → received; receiving
  adds stock. Status changes are permissioned (MANAGE).

**Transfers**
- **Transfer request** — any user can request stock from another location.
- **Approve/deny** transfer requests (OPS).
- **Direct transfer** between locations; recorded in the immutable ledger.

**Lots & Expiry**
- **Receiving** (by item or SKU) records dated **lots**; consumption is **FIFO**
  by earliest expiry.
- Expiring-soon / expired views; **discard-to-waste** on a lot.

**Vendors** *(MANAGE to edit)* — vendor master list with contact details; add /
edit / soft-delete.

**Reports** — inventory **valuation** by category + 30-day consumed cost (COGS).

**Activity** — the audit log filtered to inventory: every order, status change,
reorder, transfer, receive, waste and count, with **who did it** (name + role)
and when.

**Glossary** — the item catalog: every item with description, SKU, category,
unit, notes; add / edit / remove (soft-delete).

**Also:** **waste/spoilage** logging and **cycle counts** (system-vs-counted
variance) with an immutable transaction ledger.

**Endpoints (selection):** `GET /` (stock), `/dashboard`, `/warehouse`,
`/categories`, `/vendors` (+ CRUD), `/supply-orders`, `POST /order`,
`/reorder-suggestions`, `POST /reorder/create`, `PUT /order/:id`,
`/transfer-requests` (+ create/update), `POST /transfer`, `/transactions`,
`POST /receive`, `/lots`, `/expiring`, `POST /lots/:id/discard`,
`POST /waste`, `POST /count`, `/counts`, `/valuation`, `/audit`,
`PUT/DELETE /:id`.

### 5.5 Central Kitchen  *(owner, admin only)*

The production & supply hub for all stores. It is a special `central_kitchen`
location — present in the Locations directory but hidden from store inventory
switchers. Six tabs:

**Overview** — KPIs (products, low-stock, stores requesting today, batches
produced today, CK staff, open tasks) + quick links.

**Demand** *(Demand Aggregation)*
- Aggregates each day's item requests from all 10 stores: per-product totals,
  store count, on-hand vs safety, and a click-to-expand **per-store breakdown**.
- **⚡ Generate from sales** — rebuilds the day's store requests automatically
  from each store's **7-day average covers × per-cover usage**, so demand
  reflects real consumption instead of manual guesses.

**Production** *(Batch Scaling & Yield Control)*
- **Batch sheets** — for each product, scales batches to cover demand + restore
  safety stock, net of on-hand: `batches = ceil(need / usable-per-batch)` where
  `usable = batch_yield × (1 − shrinkage)`.
- Tracks **gross output, usable output, yield loss**, and scaled ingredient
  totals with cost (from live inventory prices).
- **Safety-stock alerts** for any product below its safety level.
- **Record production run** — logs actual output and updates on-hand; recent
  runs list.

**Recipes** *(Master-Recipe Editor)*
- Table of all CK products with batch yield, shrinkage %, usable/batch, safety
  stock, on-hand, batch cost and ingredient count.
- **Add / edit product** — name, unit, batch yield, shrinkage, safety stock,
  on-hand.
- **Recipe editor** — add/remove per-batch ingredients from an inventory-cost
  backed picker; batch cost recomputes live.

**Fulfillment** *(Fulfillment & Logistics)*
- **Consolidated pick-list** — total quantity to pick per product across stores.
- **Delivery manifests** grouped by truck route (North Bay, Peninsula, South
  Bay, SoCal) with stops.
- **Per-store packing slips**; a **Fulfill** button per store.
- **Fulfilling delivers stock into the store's own inventory** — upserts the
  products into that store's stock (category "Prepared (Central Kitchen)") and
  records a logged **in** transfer in the store ledger, while deducting CK
  on-hand.

**CK Staff** *(Central Kitchen HR)*
- **PIN time-clock terminal** — staff clock in/out by PIN → timesheets; recent
  clock activity with on-shift indicators.
- **Task assignments** — assign tasks; **photo-verified** tasks require a photo
  reference to complete.
- **Shift schedule** — view/add shifts.
- **Staff roster** with role, hourly rate, and PIN status.

**Endpoints:** `/summary`, `/demand`, `POST /generate-requests`, `/products`
(+ `POST`, `PUT /:id`, `PUT /:id/recipe`), `/ingredients`, `/batch-plan`,
`POST /production`, `/production`, `/fulfillment`, `POST /fulfill/:locationId`,
`/staff`, `/tasks` (+ `POST`, `PUT /:id/complete`), `/schedule` (+ `POST`),
`POST /clock`, `/timeclock`. **All owner/admin only.**

### 5.6 Menu/Recipes  *(owner, admin, manager)*

**Menu tab** — menu items and categories, full CRUD (name, price, category,
active flag).

**Recipes tab** — link each menu item to its inventory ingredients per serving;
shows **live recipe cost, food-cost %, and margin** derived from each
ingredient's average inventory unit cost — so the menu is wired to real stock
prices.

**Costing tab** — every item with food-cost % against a ≤30 / 30–40 / >40
target band.

**Endpoints:** `/categories` (+ `POST`), `/items` (+ `POST`, `PUT/:id`,
`DELETE/:id`), `/items/:id/recipe` (`GET`/`PUT`), `/ingredients`, `/costing`.

### 5.7 Reports  *(owner, admin, manager)*

All reports take location + date-range filters; owner/admin see all locations,
managers are scoped to theirs.

| Tab | Contents | Endpoint |
|---|---|---|
| **Items** | Inventory value by category/location, top items, 30-day COGS | `GET /api/reports/inventory` |
| **Sales** | Revenue, covers, average check; daily + by-location | `GET /api/reports/sales` |
| **Analytics** | Revenue trend, food-cost %, labor-cost %, best/lowest location | `GET /api/reports/analytics` |
| **Timesheets** | Staff hours + labor cost from hourly rates | `GET /api/reports/timesheets` |
| **Payments** | Cash / card / online split by location | `GET /api/reports/payments` |

### 5.8 Messages  *(all levels)*

Internal team messaging.

- **Inbox** — messages with unread badges (sidebar + tab); click to mark read.
- **Sent** — sent messages with per-recipient read progress.
- **Compose** — direct to a person, or **broadcast** to all staff or a whole
  location (broadcasts are manager-and-above only). Everyone can send direct
  messages.

**Endpoints:** `/recipients`, `/unread-count`, `/inbox`, `/sent`,
`POST /:id/read`, `POST /` (send).

---

## 6. Cross-cutting features

- **Audit log** — every consequential action (orders, status changes, reorders,
  transfers, receives, waste, counts, CK production/fulfillment/generation) is
  recorded with actor name + role and timestamp. Surfaced in Inventory → Activity.
- **Immutable ledgers** — inventory transactions and lots are append-only for
  traceability and spoilage control.
- **RBAC everywhere** — enforced in the API (403s) and mirrored in the UI.
- **Location scoping** — non-admin roles are pinned to their location across
  every module and report.
- **Soft-deletes** — items and vendors are deactivated (never hard-deleted) so
  history stays intact.

---

## 7. Data model

Grouped SQLite tables (`db/schema.js`):

- **Identity & org:** `users`, `locations`, `location_hours`, `equipment`
- **Inventory:** `inventory`, `inventory_transactions`, `inventory_lots`,
  `vendors`, `supply_orders`, `transfer_requests`, `waste_log`, `cycle_counts`
- **Menu:** `menu_categories`, `menu_items`, `recipe_ingredients`
- **Central Kitchen:** `ck_products`, `ck_recipe_ingredients`, `store_requests`,
  `ck_production_runs`, `ck_tasks`, `ck_shifts`
- **Operations & comms:** `daily_sales`, `timesheets`, `messages`,
  `message_recipients`, `audit_log`

---

## 8. API surface

All endpoints require a valid Bearer token (except `POST /api/auth/login`).

| Router | Base path | Purpose |
|---|---|---|
| auth | `/api/auth` | login, me, change-password |
| core | `/api` | staff directory & management |
| inventory | `/api/inventory` | stock, orders, transfers, lots, vendors, waste, counts, valuation, audit |
| menu | `/api/menu` | menu items, categories, recipes, costing |
| reports | `/api/reports` | inventory, sales, payments, timesheets, analytics |
| messages | `/api/messages` | inbox, sent, compose, unread |
| locations | `/api/locations` | directory, details, hours, equipment |
| central | `/api/central` | Central Kitchen (demand, production, recipes, fulfillment, HR) |

---

## 9. Demo accounts

| Email | Password | Role |
|---|---|---|
| `harry@phohanoi.com` | `Harry123!` | Owner (all locations) |
| `admin@phohanoi.com` | `Admin123!` | Admin |
| `manager1@phohanoi.com` | `Manager123!` | Manager |
| `support@phohanoi.com` | `Support123!` | Support |
| `employee@phohanoi.com` | `Employee123!` | Employee |

Central-kitchen staff PINs (time clock): `1111` (Trang Le, manager),
`2222` (Bao Nguyen, support), `3333` (Mai Pham, employee).

---

## 10. Run & test

```bash
cd management-app
npm install
npm run seed     # load demo data
npm start        # http://localhost:4001
npm run smoke    # 120 end-to-end API checks
```
