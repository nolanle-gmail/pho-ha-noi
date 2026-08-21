# Phở Hà Nội — Platform Handbook

_Last updated: August 21, 2026_

One reference for the whole system: how the apps fit together, the full back-end
database design, the day-to-day workflows, and a role-by-role guide you can hand
to staff at any location for testing.

> **Owner:** Harry Nguyen · **Stack:** Node.js + Express + built-in `node:sqlite`,
> vanilla-JS front ends (no build step) · **Scale:** 10 stores + 1 central
> kitchen · **48 tables** across 2 databases.

A styled, interactive version of this document (with rendered diagrams and a
sticky table of contents) is also published as a Claude Artifact.

## Contents

1. [Platform overview](#1-platform-overview)
2. [System architecture](#2-system-architecture)
3. [Database design](#3-database-design)
4. [Table catalog](#4-table-catalog)
5. [The apps in detail](#5-the-apps-in-detail)
6. [Workflows](#6-workflows)
7. [Access levels](#7-access-levels)
8. [User guide by role](#8-user-guide-by-role)
9. [Test plan & logins](#9-test-plan--logins)

---

## 1. Platform overview

Phở Hà Nội runs on **two deployed services** that together present **four things**
a person actually uses. Everything is scoped by **location** and gated by **access
level**, so the same platform serves an owner watching all ten stores and a busser
who only sees their own tasks.

| Surface | Where | What it is |
|---|---|---|
| **Management app** | service · port 4001 | The back-office console — staff, locations, inventory, central kitchen, menu & recipes, scheduling, timesheets, reports, messaging. The **system of record**. |
| **Waitlist / Front Desk app** | service · port 4002 | The host station for a single store: run the waiting list, seat parties onto the floor, launch the guest kiosk and the staff time clock. |
| **Guest Check-in kiosk** | surface · no login | A public page (`/checkin`) or QR at the door. Guests join the waitlist themselves and track their spot live until "your table is ready." |
| **Staff app** | surface · staff PWA | The floor-facing phone app for servers, hosts and bussers: my tasks, my tables, the live floor, team messages, my hours. Installs to the home screen. |

> **"Check-in" and "check-out" mean two different things here.** Guests *check in*
> to the waiting list at the kiosk. Staff *check in / check out* on the time-clock
> station to start and end a shift. Both are covered in [Workflows](#6-workflows).

---

## 2. System architecture

Each service is a small Node.js + Express app with its own SQLite database, a
vanilla-JS single-page front end, and a REST API under `/api/*`. Auth is a 12-hour
JWT; passwords are bcrypt hashes.

The Management app holds the authoritative data. The Front Desk and Staff apps read
and write the shared operational data (floor plan, guest visits, staff messages,
time clock) by calling Management over a trusted **service key** — so both apps act
on one source of truth instead of keeping parallel copies.

```mermaid
flowchart TB
  subgraph clients[People]
    G([Guest phone / lobby tablet])
    H([Host at front desk])
    S([Server / Host / Busser])
    M([Manager / Owner / Analyst])
  end

  subgraph wl[Waitlist service · 4002]
    KIOSK[Guest Check-in kiosk]
    FD[Front Desk station]
    STAFF[Staff app PWA]
    CLK[Time-clock station]
    WLDB[(Waitlist DB)]
  end

  subgraph mg[Management service · 4001]
    CONSOLE[Management console]
    API[REST API + RBAC]
    MGDB[(Management DB — system of record)]
  end

  G --> KIOSK
  H --> FD
  S --> STAFF
  M --> CONSOLE
  KIOSK --> WLDB
  FD --> WLDB
  FD -. service key .-> API
  STAFF -. service key .-> API
  CLK -. service key .-> API
  CONSOLE --> API
  API --> MGDB
```

*Two services, two databases. Dotted lines are trusted server-to-server calls
carrying a service key.*

- **Single-source sign-in** — the Front Desk / Staff app authenticates against the
  Management directory (the system of record), so one password per person works
  across both apps and can't drift. Local Front-Desk accounts are an **offline
  break-glass** only: if Management is unreachable, a host can still sign in and keep
  the local waiting list running.
- **Service key + `as=`** — cross-app calls send `X-Service-Key` and act "as" the
  signed-in staff email, so Management applies that person's permissions.
- **Server-sent events** — one SSE stream pushes waitlist, visit and message
  changes to the boards sub-second; a seated guest appears on the floor instantly.

**Deployment.** Both services deploy to Fly.io on every push to `main` via GitHub
Actions — Management at `pho-ha-noi-management.fly.dev`, Waitlist at
`pho-ha-noi-waitlist.fly.dev`. HTTPS is forced; machines idle-sleep and cold-start
in ~1–2 s.

---

## 3. Database design

The Management database is organized into eight subject areas, each drawn on its own
below; the [table catalog](#4-table-catalog) then lists every table with its
purpose. The Waitlist database (§3.9) is deliberately small.

> **Reading the diagrams.** `PK` = primary key, `FK` = foreign key, `UK` = unique.
> A crow's-foot (many) at one end and a bar (one) at the other reads "one location
> has many staff." Only key columns are drawn to keep each figure legible — full
> columns live in the schema and the catalog.

### 3.1 People, access & locations

Every person is a `users` row with a `role` and a home `location_id`; their full HR
record is a 1:1 `staff_profiles` row, and `staff_locations` lists the other stores
they can cover. **SSN and bank details are intentionally not stored** — those stay
in the payroll provider.

```mermaid
erDiagram
  locations ||--o{ users : "home store"
  locations ||--o{ location_hours : "opening times"
  users ||--o| staff_profiles : "HR record"
  users ||--o{ staff_locations : "also works at"
  locations ||--o{ staff_locations : "covered by"
  locations {
    int id PK
    text name
    text type "restaurant / central_kitchen"
    text status
    int seats
  }
  users {
    int id PK
    text email UK
    text role "access level"
    int location_id FK
    real hourly_rate
    text employee_code
  }
  staff_profiles {
    int user_id PK,FK
    text job_title
    text employment_type
    text hire_date
    int supervisor_id FK
  }
  staff_locations {
    int user_id PK,FK
    int location_id PK,FK
  }
  location_hours {
    int id PK
    int location_id FK
    int day_of_week
    text open_time
    text close_time
  }
```

### 3.2 Floor plan & guest visits

`service_visits` is the spine of the guest experience: one row per party as it moves
`waiting → seated → in_service → paying → done`. Every move is appended to
`visit_events` for history and performance reporting.

```mermaid
erDiagram
  locations ||--o{ floor_areas : "has"
  floor_areas ||--o{ restaurant_tables : "contains"
  locations ||--o{ restaurant_tables : "at"
  restaurant_tables ||--o{ service_visits : "seats"
  users ||--o{ service_visits : "served by"
  service_visits ||--o{ visit_events : "logs"
  floor_areas {
    int id PK
    int location_id FK
    text name "Dining / Bar / Patio"
  }
  restaurant_tables {
    int id PK
    int location_id FK
    int area_id FK
    text label
    int seats
    text status
  }
  service_visits {
    int id PK
    int location_id FK
    text source "waitlist / walkin"
    text stage
    int table_id FK
    int server_id FK
    int help_flag
    int bus_flag
  }
  visit_events {
    int id PK
    int visit_id FK
    text event
    text from_stage
    text to_stage
    int actor_id FK
  }
```

### 3.3 Scheduling & jobs

A weekly `shifts` row places a person at a store on a day; each shift can carry
several jobs from the shared `jobs` catalog and paid `shift_breaks`. Separately,
`task_assignments` pins a specific day-task to a working person. Breaks are 10 min &
paid; the grid enforces 8h/day and 40h/week soft limits. When a staff member works a
day task they tap **Start** (`started_at`) then **Done** (`done_at`), and may attach
one **proof photo**, stored as bytes in `task_photos`.

```mermaid
erDiagram
  users ||--o{ shifts : "scheduled"
  locations ||--o{ shifts : "at"
  shifts ||--o{ shift_jobs : "carries"
  jobs ||--o{ shift_jobs : "assigned via"
  shifts ||--o{ shift_breaks : "includes"
  locations ||--o{ location_tasks : "enables"
  jobs ||--o{ location_tasks : "listed at"
  jobs ||--o{ task_assignments : "of"
  users ||--o{ task_assignments : "done by"
  locations ||--o{ task_assignments : "at"
  task_assignments ||--o| task_photos : "proof photo"
  jobs {
    int id PK
    text code UK
    text name
    text department
    text kind "standard / specific"
  }
  shifts {
    int id PK
    int user_id FK
    int location_id FK
    text shift_date
    text start_time
    text end_time
    text kind "work / sick / vacation / leave"
    int all_day
    real leave_hours
  }
  shift_jobs {
    int shift_id PK,FK
    int job_id PK,FK
  }
  shift_breaks {
    int id PK
    int shift_id FK
    text start_time
  }
  task_assignments {
    int id PK
    int job_id FK
    int user_id FK
    text task_date
    int done
    text started_at
    text done_at
  }
  task_photos {
    int task_id PK,FK
    text mime
    blob bytes
    int uploaded_by FK
  }
  location_tasks {
    int id PK
    int location_id FK
    int job_id FK
  }
```

### 3.4 Time clock, overtime & approvals

A `time_entries` row is one work day: clock-in snapshots the scheduled span,
clock-out fills worked minutes and any `late_minutes`. Overtime needs a manager's
`ot_approvals` sign-off (which can be escalated to Owner / GM / Admin); managers can
`time_adjustments` (rounding) and finally `timesheet_approvals` a whole period.

```mermaid
erDiagram
  users ||--o{ time_entries : "punches"
  locations ||--o{ time_entries : "at"
  time_entries ||--o{ staff_alerts : "may raise"
  users ||--o{ ot_approvals : "for"
  users ||--o{ time_adjustments : "for"
  users ||--o{ timesheet_approvals : "signed off"
  time_entries {
    int id PK
    int user_id FK
    text work_date
    text clock_in
    text clock_out
    int worked_minutes
    int late_minutes
  }
  ot_approvals {
    int id PK
    int user_id FK
    text work_date
    int approved
    int ot_minutes
    int escalated
  }
  time_adjustments {
    int id PK
    int user_id FK
    text work_date
    int adjusted_minutes
  }
  timesheet_approvals {
    int id PK
    int user_id FK
    text period_kind
    int total_minutes
  }
  staff_alerts {
    int id PK
    int user_id FK
    text kind "short_shift"
    int resolved
  }
```

### 3.5 Inventory & stock movement

Stock is per `(item, location)`. Every movement is an immutable
`inventory_transactions` row; received stock also lands as `inventory_lots` drawn
down FIFO by expiry. Purchase orders, transfers, waste and cycle counts all feed the
ledger. PO lifecycle: `pending → approved → shipped → received` (receiving adds
stock).

```mermaid
erDiagram
  locations ||--o{ inventory : "stocks"
  inventory ||--o{ inventory_transactions : "moves"
  inventory ||--o{ inventory_lots : "received as"
  inventory ||--o{ waste_log : "written off"
  inventory ||--o{ cycle_counts : "counted"
  vendors ||--o{ supply_orders : "supplies"
  inventory ||--o{ supply_orders : "reorders"
  locations ||--o{ transfer_requests : "from / to"
  inventory {
    int id PK
    int location_id FK
    text item_name
    real quantity
    real min_quantity
    real par_level
    real unit_cost
  }
  inventory_transactions {
    int id PK
    int item_id FK
    text type "in / out / transfer_sent"
    real quantity
  }
  inventory_lots {
    int id PK
    int item_id FK
    real quantity
    text expiry_date
  }
  supply_orders {
    int id PK
    int item_id FK
    int vendor_id FK
    text status
  }
  transfer_requests {
    int id PK
    int from_location_id FK
    int to_location_id FK
    text status
  }
  vendors {
    int id PK
    text name
    int lead_time_days
  }
  waste_log {
    int id PK
    int item_id FK
    real quantity
    text reason
  }
  cycle_counts {
    int id PK
    int item_id FK
    real variance
  }
```

### 3.6 Central kitchen

The central kitchen produces broths and prepped proteins. Stores submit
`store_requests` (demand); `ck_production_runs` record batch output with
yield/shrinkage; fulfilling a request delivers stock into that store's inventory as
a logged transfer.

```mermaid
erDiagram
  ck_products ||--o{ ck_recipe_ingredients : "master recipe"
  ck_products ||--o{ store_requests : "requested"
  locations ||--o{ store_requests : "by store"
  ck_products ||--o{ ck_production_runs : "produced"
  users ||--o{ ck_tasks : "assigned"
  users ||--o{ ck_shifts : "scheduled"
  ck_products {
    int id PK
    text name
    real batch_yield
    real shrinkage_pct
    real safety_stock
    real on_hand
  }
  ck_recipe_ingredients {
    int id PK
    int product_id FK
    text item_name
    real quantity
  }
  store_requests {
    int id PK
    int location_id FK
    int product_id FK
    real quantity
    text status
  }
  ck_production_runs {
    int id PK
    int product_id FK
    real batches
    real actual_output
  }
  ck_tasks {
    int id PK
    int assigned_to FK
    int requires_photo
  }
  ck_shifts {
    int id PK
    int user_id FK
    text shift_date
  }
```

### 3.7 Menu & recipes

Menu items belong to categories; each item's `recipe_ingredients` link to inventory
items by name, so food cost is computed live from real stock unit costs.

```mermaid
erDiagram
  menu_categories ||--o{ menu_items : "groups"
  menu_items ||--o{ recipe_ingredients : "costs from"
  inventory ||..o{ recipe_ingredients : "by item_name"
  menu_categories {
    int id PK
    text name
    int sort_order
  }
  menu_items {
    int id PK
    int category_id FK
    text name
    real price
  }
  recipe_ingredients {
    int id PK
    int menu_item_id FK
    text item_name
    real quantity
  }
```

### 3.8 Equipment, sales, messaging & audit

The remaining tables round out the console: equipment registers per location, daily
sales for reporting, threaded team `messages` with per-recipient read state, and two
audit trails.

```mermaid
erDiagram
  locations ||--o{ equipment : "assets"
  locations ||--o{ daily_sales : "revenue"
  users ||--o{ messages : "sends"
  messages ||--o{ message_recipients : "fans out"
  users ||--o{ message_recipients : "receives"
  messages ||--o{ messages : "thread / reply"
  users ||--o{ activity_log : "acts"
  equipment {
    int id PK
    int location_id FK
    text name
    text status
    text next_service
  }
  daily_sales {
    int id PK
    int location_id FK
    text sale_date
    real total_revenue
    int cover_count
  }
  messages {
    int id PK
    int sender_id FK
    text audience "direct / all / location"
    int thread_id
    int parent_id
  }
  message_recipients {
    int id PK
    int message_id FK
    int user_id FK
    int is_read
    int archived
  }
  activity_log {
    int id PK
    int user_id FK
    text path
    int status
  }
  audit_log {
    int id PK
    int user_id FK
    text action
  }
```

### 3.9 Waitlist database

The Front Desk app keeps a lean local database: its own `users`, the `waitlist`
parties (with `source` = staff or self-kiosk and a `public_ref` code for live
tracking), the page log, a local floor plan, and its own audit trails.

```mermaid
erDiagram
  locations ||--o{ users : "staff"
  locations ||--o{ waitlist : "queue"
  waitlist ||--o{ notify_log : "pages"
  locations ||--o{ floor_areas : "areas"
  floor_areas ||--o{ restaurant_tables : "tables"
  locations {
    int id PK
    text name
    int avg_turn_minutes
  }
  waitlist {
    int id PK
    int location_id FK
    text guest_name
    int party_size
    text status "waiting / seated / left"
    text source "staff / self"
    text public_ref
  }
  users {
    int id PK
    text email UK
    text role "owner / manager / frontdesk"
  }
  notify_log {
    int id PK
    int waitlist_id FK
    text channel
  }
  restaurant_tables {
    int id PK
    int location_id FK
    text label
  }
```

---

## 4. Table catalog

### Management database — 41 tables

| Table | Domain | Purpose |
|---|---|---|
| `users` | People | Staff accounts: name, email, role, home location, hourly rate |
| `staff_profiles` | People | Full HR record, 1:1 with users (no SSN / bank data) |
| `staff_locations` | People | Additional stores a person can work at |
| `locations` | Org | Restaurants + the central kitchen |
| `location_hours` | Org | Per-day opening / closing times |
| `floor_areas` | Floor | Named areas (Dining, Bar, Patio) per store |
| `restaurant_tables` | Floor | Numbered tables with position, seats & live status |
| `service_visits` | Service | The guest-visit spine: waiting → seated → done |
| `visit_events` | Service | Append-only log of every visit stage change & check |
| `shifts` | Schedule | Weekly shift: person × day × store, start/end |
| `shift_jobs` | Schedule | Jobs attached to a shift |
| `shift_breaks` | Schedule | Paid 10-min breaks within a shift |
| `jobs` | Schedule | Shared job/task catalog by department |
| `task_assignments` | Schedule | A specific day-task pinned to a working person, with Start/Done timestamps |
| `task_photos` | Schedule | Optional proof photo for a day task (image bytes in the DB) |
| `location_tasks` | Schedule | Which specific tasks apply at which store |
| `time_entries` | Time | One work day: clock-in/out, worked & late minutes |
| `ot_approvals` | Time | Manager approval of overtime; can escalate |
| `time_adjustments` | Time | Manager rounding of a day's worked minutes |
| `timesheet_approvals` | Time | Sign-off on a period's total hours |
| `staff_alerts` | Time | Alerts to a manager (e.g. left early) |
| `inventory` | Inventory | Stock per item per location with min/par/cost |
| `inventory_transactions` | Inventory | Immutable in/out/transfer movement ledger |
| `inventory_lots` | Inventory | Received batches with expiry, drawn FIFO |
| `vendors` | Inventory | Supplier master records |
| `supply_orders` | Inventory | Purchase orders with a lifecycle |
| `transfer_requests` | Inventory | Inter-location transfers with approval |
| `waste_log` | Inventory | Spoilage / write-offs with reason |
| `cycle_counts` | Inventory | Physical counts vs system (variance) |
| `ck_products` | Central K. | Items the central kitchen produces |
| `ck_recipe_ingredients` | Central K. | Master recipe per product |
| `store_requests` | Central K. | Daily item requests from each store |
| `ck_production_runs` | Central K. | Batch runs with yield & shrinkage |
| `ck_tasks` | Central K. | Photo-verified kitchen tasks |
| `ck_shifts` | Central K. | Central-kitchen shift schedule |
| `menu_categories` | Menu | Menu groupings |
| `menu_items` | Menu | Dishes with price |
| `recipe_ingredients` | Menu | Item → inventory ingredient links for costing |
| `equipment` | Assets | Equipment register with maintenance schedule |
| `daily_sales` | Reporting | Per-day revenue & covers by location |
| `messages` · `message_recipients` | Messaging | Threaded team messaging + per-person read state |

Plus `audit_log`, `activity_log` and the legacy `timesheets` table.

### Waitlist database — 8 tables

| Table | Purpose |
|---|---|
| `locations` | Stores, each with an average table-turn time for quoting waits |
| `users` | Front-desk accounts (owner / manager / frontdesk) |
| `waitlist` | Parties in the queue: staff- or self-added, with a live tracking code |
| `notify_log` | Record of every "your table is ready" page |
| `floor_areas` · `restaurant_tables` | Local floor plan for seating |
| `audit_log` · `activity_log` | Who-did-what and access trails (incl. guest check-ins) |

---

## 5. The apps in detail

### Management console (port 4001)

A left sidebar filtered by access level, with per-module tab bars. Managers land on
a location dashboard; self-service staff land on a personal home screen.

| Module | What's inside | Who |
|---|---|---|
| **Overview** | KPI tiles, today's roster, schedule health, needs-attention panel | All (manager dashboard for managers) |
| **Locations** | Directory + details, operating hours, staff, weekly schedule, equipment register | Owner/Admin all · Manager own |
| **Staff** | Directory (A–Z), full HR-profile edit, jobs/tasks catalog, access-level matrix, activity log. **Add staff** + access-level/location changes are owner/admin-only; **managers edit their own store's staff** (name, status, password, all HR fields) | Owner/Admin/Manager |
| **Inventory** | Stock, orders & reorder, transfers, lots & expiry, vendors, reports, glossary | Ops+ (own location) |
| **Central Kitchen** | Demand, production, recipes, fulfillment, CK staff & PIN clock | Owner/Admin/GM |
| **Menu / Recipes** | Menu items, recipe links, live food-cost costing | Manage tier |
| **Reports** | Items, sales, analytics, timesheets, payments — location + date filters | Reports tier |
| **Messages** | Inbox, sent, compose (direct or broadcast) | All |
| **My Schedule** | Read-only weekly shifts across every store they work | Scheduled staff |

> **Editing staff.** Open a person from Staff → Directory and click **Edit** to change
> their **full HR profile** — Account (name), Personal, Contact, Mailing address,
> Emergency contact, Employment, Payroll, "Also works at," and Skills/Notes — plus
> reset password and activate/deactivate. **Who can edit whom:**
> - **Owner / Admin** — anyone, every field, including **access level** and **home
>   location**; only they can **Add staff**.
> - **Managers** — their own store's staff (all-location managers: any store), but not
>   owner/admin accounts. They edit the full profile, status, and password, while
>   **access level, home location, and email stay read-only** and there's **no Add
>   staff** button.
>
> Email is the sign-in and is read-only for everyone; change access level or location
> to move someone between roles or stores (owner/admin).

### Front Desk / Waitlist app (port 4002)

The authenticated host station, scoped to the signed-in host's store (owners get a
store switcher). Runs the live queue with waited time and quoted wait, add-party,
notify/page, seat (onto a table) and mark-left, plus live stats, "handled today"
history, guest history & daily reports (owner/admin), and an access/activity log
(owner).

### Guest Check-in kiosk (no login)

Public page at `/checkin`, or per-store `/checkin/<slug>` / `/checkin?loc=<id>` for
a lobby tablet or QR. The guest sees the current wait, enters name / party size /
phone and special-request chips (high chair, booth, patio, birthday…), joins, and
then **tracks their spot live** — the screen flips to "🔔 Your table is ready!" the
moment the host pages them. Hardened with per-IP rate limits, a duplicate-submit
guard and a 16 KB body cap.

### Staff app (PWA)

The floor-facing phone app. Installs to the home screen; its nav collapses to a
hamburger drawer on phones. Views depend on role:

| View | Purpose | Shown to |
|---|---|---|
| 📋 My Tasks | Assigned day-tasks — Start, Done, and an optional proof photo | Everyone |
| 🛎️ My Tables | The staff member's own tables, claim queue & timed checks | All front & back-of-house roles |
| 🍜 Front Desk | The live waiting-list board for the store | Host / Front Desk / managers |
| 🍽️ Floor | Live table map — front-of-house + managers can seat / update; kitchen roles view-only | All front & back-of-house roles + managers |
| ✉️ Messages | Team inbox with unread badge | Everyone |
| ⏱ My Hours | Own timesheet — day / week / month, OT & late | Everyone |
| 📜 📊 🧾 History / Report / Activity | Cross-store oversight | Owner |

### Time-clock station (shared terminal)

A "Check in / Check out" screen (in Management, and reachable from the Staff app)
where a staff member punches in and out for a shift. Check-in snapshots the day's
scheduled span; check-out computes worked minutes, lateness and any overtime, and
can warn if someone's leaving early.

---

## 6. Workflows

### 6.1 The guest journey — check-in to done

A party joins the list one of two ways, then moves across the floor as a single
visit. Every arrow appends a `visit_events` row for history and performance
reporting.

```mermaid
flowchart TB
  A1[Guest self check-in at kiosk] --> W
  A2[Host adds a phone-in / walk-in] --> W
  W[On the waiting list · WAITING] --> N[Host pages guest · table ready]
  N --> SEAT[Host seats party onto a table]
  A3[Walk-in seated straight away] --> SEAT
  SEAT --> V[Service visit · SEATED]
  V --> CLAIM[Server claims the table]
  CLAIM --> SERV[IN SERVICE · timed checks 5/10/20 min]
  SERV -->|needs a hand| HELP[Help flag to manager]
  SERV --> PAY[PAYING]
  PAY --> DONE[DONE · table flagged to bus]
  DONE --> BUS[Busser clears · table AVAILABLE]
```

1. **Join the list** — Guest self-checks-in at the kiosk (lands tagged *SELF
   CHECK-IN*), or the host adds them. A pure walk-in the host seats immediately
   skips waiting.
2. **Page & seat** — When a table frees, the host pages the guest (kiosk flips to
   "table ready") and seats them onto a specific table — creating the service visit.
3. **Serve** — A server claims the table on the Staff app, works timed checks, and
   can raise a help flag for a manager.
4. **Close out** — Move to paying, then done; the table is flagged for a busser, who
   clears it back to available.

### 6.2 Staff check-in / check-out & payroll

```mermaid
flowchart LR
  IN[Check in · snapshot scheduled span] --> ON[On the clock]
  ON --> OUT[Check out · worked + late minutes]
  OUT -->|left early| AL[Short-shift alert to manager]
  OUT -->|over scheduled| OT[Overtime pending]
  OT --> MGR{Manager review}
  MGR -->|approve| OK[OT approved]
  MGR -->|escalate| LEAD[Owner / GM / Admin queue]
  OK --> ADJ[Optional rounding adjustment]
  ADJ --> SIGN[Timesheet approved for the period]
```

Time flows from the clock station into the manager's review and a period sign-off.
Staff watch their own totals in **My Hours**.

### 6.3 Weekly scheduling

A manager builds the week from the Location → Schedule grid (every staff member ×
seven days):

- Click **+** on a day → set start/end, pick one or more **jobs** from the catalog,
  add paid **breaks** (10 min each; unlocked once a shift is ≥ 3.5 h; max 2/day
  unless the day tops 10 h).
- A day can hold multiple work periods (e.g. 8–12 and 12–16), each with its own
  break.
- Soft limits: **8 h/day** and **40 h/week** turn the cell red ⚠ and block the save
  until the manager ticks **"Approve overtime exception"** — so going over is
  deliberate.
- Because each shift carries its own location, a person can be scheduled at different
  stores on different days; away shifts show as read-only "@ store" cards.
- **Leave** — the **+** entry has a **Type**: Work shift, or **Sick / Vacation /
  On-leave**. Leave takes a duration — **all day** (8 h), a **number of hours**, or a
  **from–to** span — and shows as a coloured chip (🤒 / 🏖️ / 🗓️). Leave never counts
  toward worked hours or the 8h/40h limits; instead the **timesheet totals it as sick,
  vacation, or leave hours** — on the person's **My Hours** (Sick / Vacation / On-leave
  tiles) and on the manager's **Timesheet** as a **Leave** column (per-period total,
  included in the CSV export). A person's HR **status** can also be set to `on_leave`
  on their profile.

### 6.4 Inventory replenishment & the central kitchen

```mermaid
flowchart TB
  PAR[Stock below par] --> SUG[Auto-reorder suggestion · build-to-par]
  SUG --> PO[Purchase order · pending]
  PO --> AP[approved] --> SH[shipped] --> RC[received → stock + lot in]
  RC --> USE[FIFO consumption by expiry]
  subgraph CK[Central kitchen]
    REQ[Stores submit demand] --> PROD[Production run · yield / shrinkage]
    PROD --> FUL[Fulfill → delivers into store inventory as an 'in' transfer]
  end
  FUL --> USE
  XFER[Inter-location transfer request] --> USE
```

Two ways stock arrives: vendor POs and central-kitchen fulfillment. Waste and cycle
counts also adjust the ledger.

### 6.5 Team messaging

Everyone can send **direct** messages; managers and above can **broadcast** to all
staff or a whole location. Assigning a task notifies the assignee. Threads support
replies, mark-unread and archive, and unread counts push to the sidebar/nav badge in
real time.

| Sender | Can message |
|---|---|
| Owner / Admin / GM | Anyone — everyone, a group, or an individual |
| Manager | Owner/admin, their staff, and manager peers |
| Staff (self-service) | Their manager, owner/admin, and peers |

### 6.6 Daily tasks: start, done, proof photo

Managers assign specific day tasks on the Management **Day Tasks** board. Each
working staff member sees their own tasks in the Staff app's **My Tasks**:

```mermaid
flowchart LR
  TODO[To-do] -->|tap Start| PROG[In progress · started_at]
  PROG -->|optional| PHOTO[Attach proof photo]
  PHOTO --> PROG
  PROG -->|tap Done| DONE[Done · done_at]
  DONE -->|Undo| PROG
```

1. **Start** — the staff member taps Start; `started_at` is stamped and the card
   shows as in progress.
2. **Proof photo (optional)** — before finishing, they may attach one photo (camera
   or library). It's sent as raw image bytes and stored in `task_photos` on the
   Management DB volume, then shown as a thumbnail (tap to zoom).
3. **Done** — tapping Done stamps `done_at`. The manager's Day Tasks board sees the
   Start/Done times and can view the proof photo.

The photo is optional — a task can be completed without one. Managers and the task's
owner can view a stored photo; it persists with the database.

---

## 7. Access levels

Access levels are defined once in `lib/auth.js` as a **scope** (all locations /
their own / just themselves) plus **capabilities**. Route permissions, the sidebar,
and the on-screen access-level page all derive from that one table — and the API
returns **403** on any disallowed action, so hiding in the UI is convenience, not
the security boundary.

**Scopes:** `all` (sees and switches between every location) · `location` (pinned to
their own store) · `self` (only their own schedule, tasks & messages).

| Access level | Scope | Capabilities | In short |
|---|---|---|---|
| **Owner** | all | org · manage · ops · reports · central | Everything; only an owner can create owners |
| **Admin** | all | org · manage · ops · reports · central | Everything; created by an owner |
| **General Manager** | all | manage · ops · reports · central | Operations across every store |
| **Regional Manager** | all | manage · ops · reports | Multi-store ops, no central kitchen |
| **Manager** | location | manage · ops · reports | Runs their own store end to end |
| **Assistant / Kitchen Manager** | location | manage · ops · reports | Same store powers, lower rank |
| **Analyst / Accountant** | all | reports | Read-only reports & analytics, all stores |
| **Inventory Support** | location | ops | Stock operations at their store |
| **Driver** | location | delivery | Read-only delivery manifests + own schedule |
| **Server · Host · Busser · Chef · Line/Prep Cook · Cashier · Bartender · Barista · Dishwasher** | self | — | My schedule, my tasks, messages, my hours |

> **Positions share permissions, differ by title.** Server, Host, Busser and the
> kitchen positions are all `self`-scoped with the same access — the job title just
> changes what they're called and which Staff-app views appear.

---

## 8. User guide by role

Hand each tester the section that matches their job.

### Owner / Admin

1. **Sign in to the Management console** — you land on an org-wide overview. Use the
   location picker (top bar) to switch between all ten stores + the central kitchen.
2. **Add a staff member** — Staff → Add staff: fill the account + HR profile, set
   access level, home location and any "also works at" stores. Confirm they appear
   in the A–Z directory.
3. **Check the central kitchen** — Central Kitchen → Demand → "Generate from sales",
   then Production to scale a batch sheet, then Fulfillment to deliver into a store.
4. **Review reports & the activity log** — Reports for sales/analytics/timesheets;
   Staff → Activity Log for every sign-in, change and denied attempt.

### Store Manager (Assistant / Kitchen Manager)

1. **Sign in** — you land on your store's dashboard (KPI tiles, today's roster,
   schedule health, needs-attention). Everything is scoped to your location.
2. **Build the week** — Locations → your store → Schedule: add shifts, attach jobs,
   add paid breaks. Try to exceed 40 h and confirm the guardrail blocks the save
   until you approve the exception.
3. **Run inventory** — Inventory → Orders & Reorder: accept an auto-reorder
   suggestion into a PO, then receive it and watch stock + a lot appear.
4. **Approve time** — Reports → Timesheets: review late/short/OT flags, approve
   overtime (or escalate), round a day, and sign off the period.
5. **Update your staff** — Staff → Directory → **Edit** on any of your store's
   people to update their full HR profile (contact, address, emergency contact,
   employment, payroll, skills/notes), status, or reset a password. Access level and
   home location changes stay with owner/admin, and only they can Add staff.

### Inventory Support · Analyst / Accountant · Driver

- **Inventory Support** (ops · own store) — sign in to Management; you get the
  Inventory module for your store (receive, transfer, count, waste, create orders).
  No staff or menu admin.
- **Analyst / Accountant** (reports · all) — sign in to Management; you get Reports
  only, read-only, across every location: sales, analytics, timesheets, payments.
- **Driver** (delivery) — sign in to Management; you get a read-only Deliveries view
  (central-kitchen manifests / packing slips) plus your own schedule and messages.

### Host / Front Desk

1. **Sign in to the Front Desk app** — header shows your store 📍. The live queue
   lists each party with waited time and quoted wait; self-check-ins are flagged.
2. **Add & seat a party** — Add party (name, size, phone — quote auto-suggests).
   When a table frees, Notify the guest, then Seat them onto a table.
3. **Or use the Staff app** — front-desk staff also get the 🍜 Front Desk board and
   🍽️ Floor in the Staff app on their phone.

### Server / Busser

1. **Open the Staff app on your phone** — you land on **My Tables**. The floor shows
   open tables to claim.
2. **Work a table** — claim a seated party, run the timed checks, raise a help flag
   if you need a manager, move to paying, then done. Bussers pick up the "ready to
   bus" flags.
3. **Check your hours** — ⏱ My Hours shows your day/week/month totals with late and
   overtime highlighted.

### Kitchen & other positions (Chef, Line/Prep Cook, Cashier, Bartender, Barista, Dishwasher)

Self-service everywhere: **My Schedule** (Management) or the Staff app's **My
Tasks**, **Messages** and **My Hours**. Punch in and out at the time-clock station.

### Guest (no login)

Walk up to the lobby tablet or scan the store QR → open `/checkin`, enter name /
party size / phone / any requests, join, and keep the screen open to watch your
place in line until "your table is ready."

---

## 9. Test plan & logins

> **Shared demo sandbox.** Anyone signed in can edit the data — please don't enter
> real guest or staff information while testing. Machines idle-sleep and cold-start
> in ~1–2 s.

### Where to go

| Surface | URL |
|---|---|
| Management console | `pho-ha-noi-management.fly.dev` |
| Front Desk / Staff app | `pho-ha-noi-waitlist.fly.dev` |
| Guest self check-in | `pho-ha-noi-waitlist.fly.dev/checkin` |

### Demo logins

> **One login, both apps.** Sign-in is unified to the Management directory, so **the
> same email + password works on both the Management console and the Staff / Front
> Desk app** — every account below is verified working on both. Signing in works
> everywhere; each role then sees the UI appropriate to it (e.g. an Analyst or Driver
> can open the Staff app but only sees the self-service views — My Tasks, Messages,
> My Hours). Front-desk staff use the Staff app; back-office roles use the console.

| Role | Email | Password |
|---|---|---|
| Owner (all) | `harry@phohanoi.com` | `Harry123!` |
| Admin (all) | `admin@phohanoi.com` | `Admin123!` |
| General Manager (all) | `gm@phohanoi.com` | `Gm123456!` |
| Manager (location) | `manager1@phohanoi.com` | `Manager123!` |
| Analyst (reports) | `analyst@phohanoi.com` | `Analyst123!` |
| Inventory Support (ops) | `support@phohanoi.com` | `Support123!` |
| Driver (delivery) | `driver@phohanoi.com` | `Driver123!` |
| Server (self) | `server@phohanoi.com` | `Server123!` |
| Chef (self) | `chef@phohanoi.com` | `Chef123456!` |
| Host — role `host` (waitlist) | `host@phohanoi.com` | `Host123!` |
| Front Desk — role `frontdesk` (waitlist) | `host1@phohanoi.com` | `Host123!` |

> **Note:** all logins above are verified working on production, on **both** apps. If
> a login ever fails, the owner account (`harry@phohanoi.com` / `Harry123!`) is the
> safe fallback.

### A 10-minute smoke test for a store

1. **Guest joins** — on a phone, open `/checkin`, join the list, keep the tracker
   open.
2. **Host seats** — sign in as the host, page the guest (their tracker flips to
   "ready"), seat them onto a table.
3. **Server serves** — as a server in the Staff app, claim the table, run a check,
   mark paying then done.
4. **Manager reviews** — as the manager, open Reports → Timesheets and the Overview
   dashboard; confirm the store's numbers moved.
5. **Owner watches** — as the owner, switch locations and confirm the visit shows in
   Guest History and the daily report.
