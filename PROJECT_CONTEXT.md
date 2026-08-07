# PROJECT_CONTEXT.md

**This file is the single source of truth for Trend Laundry.**

Read this file first, before starting any task. Update it immediately after finishing any task or phase. Never delete historical decisions or rewrite history — append. If documentation and code ever disagree, fix the code first, then update this file to match. This file always represents the latest known state of the project; a future conversation should be able to continue entirely from this document without needing old chat history.

*Every factual claim below was verified against the actual repository (file counts, grep results, line counts) at the time it was written — not reconstructed from memory. Where something is a plan rather than a built fact, it is labeled as such.*

---

## 1. Project Overview

**Project name:** Trend Laundry

**Purpose:** A multi-tenant SaaS backend for laundry businesses in the UAE, starting with a single real business ("Trend Laundry," Ajman) and built to serve many laundries on shared infrastructure. Replaces a frontend-only prototype (React/JSX, `window.storage`) with a real Postgres-backed API.

**Vision:** A production-grade, multi-branch, bilingual (EN/AR) laundry management platform covering customer relationships, order intake and pricing, delivery dispatch, inventory, purchasing, financial reporting, and eventually a SaaS offering to other UAE laundries. Security and auditability are treated as launch requirements, not later polish — every module ships with regression-tested RLS tenant isolation and OWASP Top 10 coverage before it counts as done.

**Current completion percentage:** Backend engineering-wise, Phases 0–7 of a planned multi-phase roadmap are complete (Foundation, Auth & Identity, Customers, Orders, Branches, Inventory, Business Settings & Branding, Delivery & Driver Management). Relative to the full commercial v1 scope described in `BACKEND-SPEC.md` (customers, orders, delivery, inventory, purchasing, expenses, reports, notifications, employees, settings) — **8 of ~14 planned modules are built and tested.** No frontend has been connected to this backend yet (the original React prototype still runs against `window.storage`); wiring the frontend to the real API is unstarted work.

**Current development phase:** Phase 7 (Delivery & Driver Management) is complete and approved. No phase is currently in progress — see §8 for what's next.

**Current project status:** Active development, phase-by-phase, with explicit stop-and-review gates between phases. Every phase so far has shipped: a migration, a repository/service/schemas/routes module, a full regression test suite (isolation, authz/injection, functional), and a phase completion report. No phase has been marked complete without code-and-test evidence for every security control it touches.

---

## 2. Technology Stack

**Frontend:** React/JSX prototype (`trend-laundry-crm-final.jsx`, `-orders.jsx`, `-delivery.jsx`, `-inventory.jsx`, `-reports.jsx`), bilingual EN/AR, currently backed by `window.storage` (browser key-value store), **not yet connected to the backend built in this repo.** Frontend-to-backend integration is unstarted.

**Backend:** Node.js 20+, TypeScript (strict mode), Fastify 4. Chosen over Express (2× throughput, native JSON-schema validation) and over Django/Rails (shared TypeScript types with a future frontend rewrite). See `BACKEND-SPEC.md` Appendix A for full alternatives-and-trade-offs reasoning.

**Database:** PostgreSQL 15+, accessed via Kysely (typed query builder) — chosen over Prisma specifically because Prisma's connection pooling model fights Postgres Row-Level Security, which is the backbone of this project's tenant isolation.

**Authentication:** Argon2id password hashing; JWT access tokens (15-minute TTL) + rotating opaque refresh tokens (30-day TTL, SHA-256-hashed at rest, family-based reuse detection). HS256 in development; RS256 required in production (the config loader refuses to boot with HS256 + `NODE_ENV=production`).

**Authorization:** Custom RBAC — 52 permission strings across 12 domains, 5 seed roles per business (owner/manager/cashier/employee/driver), enforced by an `authorize([...])` middleware on every protected route. Branch-level scoping (separate from tenant isolation) is enforced in the application layer via per-module `branch-scope.ts` helpers, not RLS.

**Storage:** No object storage integration yet. `photo_url`/`logo_url` fields exist as plain string columns across several tables (customers, branches) as placeholders for a future presigned-upload flow (spec §9) — not implemented.

**Deployment:** Not yet built. Local dev only via `docker-compose.yml` (Postgres + Redis). No Dockerfile, no CI/CD pipeline, no Nginx config, no production infrastructure exists in this repo yet — all deferred to a "Phase 8 hardening" milestone per `BACKEND-SPEC.md` §13.

---

## 3. Architecture

**Overall architecture:** Layered, single-process-per-role. Every module follows the same four-file shape: `repository.ts` (only file touching SQL for that module's tables), `service.ts` (business logic, transactions, audit writes), `schemas.ts` (Zod validation), `routes.ts` (thin HTTP handlers: parse → service call → reply). Dependency direction is strictly `routes → service → repository → db`, never reversed.

**Multi-tenancy model:** Shared database, shared schema, every tenant-owned table carries `business_id`, isolation enforced by PostgreSQL Row-Level Security with `FORCE ROW LEVEL SECURITY` (so even the table owner cannot bypass it). A `withTenant({businessId, userId}, fn)` helper in `src/lib/db.ts` runs `SET LOCAL app.business_id` inside a transaction before any query executes; RLS policies read that session variable. Chosen over database-per-tenant (unaffordable ops at scale) and application-only filtering (a single missing `WHERE` clause becomes a data breach). Full reasoning in `BACKEND-SPEC.md` Appendix A.1.

**Branch model:** Two independent authorization layers, deliberately different mechanisms:
- **Tenant isolation** (business A vs business B) = PostgreSQL RLS. Non-negotiable, defends against an adversarial tenant.
- **Branch scoping** (branch 3 vs branch 7, within the same business) = application layer, via a per-module `branch-scope.ts` file (`orders/branch-scope.ts`, `branches/branch-scope.ts`). A membership's `branch_ids: number[]` is empty for all-branch access (owners, some managers) or a specific list for scoped managers. This split is deliberate: RLS defends the catastrophic boundary (cross-tenant leak); application-layer scoping organizes access within one trusting business, where the failure mode is much lower stakes.
- Orders carry a **branch triple**: `intake_branch_id` (NOT NULL), `processing_branch_id` (nullable, NULL = same as intake), `collection_branch_id` (nullable, NULL = same as intake) — supporting hub-and-spoke laundries (shops feeding a central plant). Read access uses OR-logic across all three columns; write (create) access is narrower, requiring the intake branch specifically to be in the caller's scope.
- Branches management (Phase 4) uses a simpler rule: CREATE requires all-branch access; UPDATE/ENABLE-DISABLE/DELETE/RESTORE require the target branch in scope; READ (list/get) is business-wide regardless of scope (branch metadata is organizational information, not access-controlled data — a deliberate, documented divergence from the orders pattern, flagged for explicit product sign-off in `PHASE-4-REPORT.md` §5 and §8).
- Inventory (Phase 5) uses a third variant: catalog CRUD (`inventory_items`) has **no** branch-scope check at all (the catalog is business-wide, same as `services`); branch stock and movements (`inventory_movements`) require the target branch to be in the caller's scope for **both reads and writes** — unlike Branches, where reads are business-wide. Three modules, three different scope shapes, each deliberately fitted to what the data actually represents rather than one rule copy-pasted everywhere. See Decisions Log #18–#19.

**Repository pattern:** Every module's `repository.ts` is the *only* file issuing SQL against its tables. Functions take a `Transaction<Database>` as the first argument (supplied by `withTenant()`), so RLS is guaranteed active. Column lists are declared once as a `const X_COLUMNS = [...] as const` so every read returns a consistent shape and never leaks internal-only columns (e.g., `search_vector`). Updates build an explicit patch object field-by-field rather than spreading validated input into `.set()`, closing off any chance an unexpected key reaches the UPDATE statement.

**API structure:** REST, JSON only. Every response from an error is `{code, message, details?}` — no stack traces, no SQL, no provider text ever reaches the client (verified by dedicated tests). Successful single-resource responses are wrapped by resource name (e.g., `{customer: {...}}`, `{order: {...}}`, `{branch: {...}}`); collection/list endpoints and simple action results (e.g., delete) return their payload bare (`{data, page_info}`, `{id, deleted_at}`). **This wrapping distinction is inconsistent-looking but consistent in practice — always check the actual `reply.code(N).send(...)` call in a module's `routes.ts` before writing a test against it; two real bugs in Phase 3's first test draft came from assuming the wrong shape (see `PHASE-3-REPORT.md` §8).**

**Security architecture:** Defense in depth, four independent layers that must all fail for a cross-tenant leak: (1) JWT signature verification, (2) `authorize([...])` permission middleware, (3) branch-scope checks in the service layer where relevant, (4) PostgreSQL RLS as the backstop that holds even if 1–3 all have bugs. Every mutation writes an audit row (`activity_logs`, append-only via a database trigger) in the *same transaction* as the change it records. Full detail in §10 below and in `OWASP-COMPLIANCE.md` / `SECURITY.md`.

---

## 4. Business Rules

*Every rule below has been explicitly approved by the user during this project's development. Rules are grouped by the phase that introduced them. Newly stated rules (not yet implemented) are marked "APPROVED, NOT YET IMPLEMENTED."*

### Tenancy & identity (Phase 0–1)
- Every row in every tenant-owned table belongs to exactly one business.
- A user is a global identity and may hold memberships in more than one business.
- A business always has at least one Owner; the last Owner membership cannot be removed.
- Roles are permission bundles scoped per business (not global), so an owner can customize role names/permissions without affecting other tenants.
- Branch scope is carried on the *membership*, not the role — a "branch manager" is just a `manager`-role membership with `branch_ids` restricted to specific branches, not a distinct system role.

### Authentication (Phase 1)
- Passwords hashed with Argon2id; minimum 12 characters at signup/reset/invite-accept.
- Failed login attempts are rate-limited and lock the account after repeated failures within a window (constant-time response either way, to prevent user enumeration).
- Refresh tokens rotate on every use; reusing an already-rotated (revoked) token revokes the *entire token family*, not just that token.
- A password reset revokes every active session for that user.
- Password reset requests always return success/202 regardless of whether the email exists — never confirm or deny account existence.

### Customers (Phase 2)
- Customers are **business-scoped**, not branch-scoped — a customer can be served at any branch of the same business, and their history/statistics are business-wide (not per-branch). Confirmed explicitly by the user ahead of Phase 3: "We are building a multi-branch laundry business, not a franchise system. Franchise support can be considered in a future version."
- Customer status is an explicit enum: `active` / `inactive` / `blocked`. Blocking requires a reason (enforced by both a DB CHECK constraint and Zod validation).
- Customer phone numbers are unique per business (soft-deleted customers excluded, so a phone can be reused after deletion).
- Soft delete only — customers are never hard-deleted. Restoring a soft-deleted customer whose phone was reused by someone else in the meantime is refused with a clear conflict error, not a silent constraint violation.
- **A customer with any non-deleted order carrying an outstanding balance (`total > paid_amount`) cannot be deleted**, regardless of that order's status — a cancelled order that already took a deposit still represents money owed. (Fixed post-Phase-4, before Phase 5 — see Decisions Log #17 and Progress Log.)
- Every create/update/status-change/delete/restore/note action writes an audit row.

### Orders (Phase 3)
- **Orders are branch-aware; customers are business-scoped.** (User-approved architecture decision — see §11 Decisions Log.)
- Orders carry three branch references: `intake_branch_id` (NOT NULL), `processing_branch_id` (nullable, NULL means same as intake), `collection_branch_id` (nullable, NULL means same as intake).
- Read access to an order requires the caller's branch scope to overlap ANY of the three branch columns (OR logic).
- Order *creation* is scoped more narrowly: the caller may only create an order whose `intake_branch_id` is in their own branch scope, even if they could read orders touching other branches.
- The client never supplies money. All totals are computed server-side from the price catalogue; a client-supplied `total`/`subtotal`/`vat_amount` is rejected outright by strict schema validation.
- Order numbers are **branch-scoped** (format `{BRANCH_CODE}-{yymmdd}-{seq3}`, resets daily per branch).
- Invoice numbers are **business-scoped** (format `{PREFIX}-INV-{YYYY}-{seq6}`), gapless per UAE FTA requirements, and assigned only when an order reaches `delivered` status — never at creation, so a cancelled order never burns a number.
- Order status follows a fixed forward-only state machine (received → sorting/washing/drycleaning → ironing → packing → ready → out_for_delivery → delivered, with cancel/lost reachable from any non-terminal state). No backward transitions.
- Lines may only be edited while an order is in `received` or `sorting` status.
- A discount above 50% requires the `orders.refund` permission (an elevated/manager-level permission), not just `orders.create`.
- Refunds cannot exceed the refundable balance of a specific payment; a refund record cannot itself be refunded; a refund must be tied to a payment that belongs to the *same* order (checked explicitly — this is the fix for a real "refund laundering" vulnerability class).
- An order with any recorded payment cannot be deleted (soft delete refused; must be cancelled instead).
- A blocked customer cannot have new orders created against them.

### Branches (Phase 4)
- Every branch belongs to exactly one business.
- Branches are never hard-deleted — soft delete only (`deleted_at`), paired with a restore path.
- **A branch with any historical order referencing it (via ANY of the three branch columns, including soft-deleted orders) cannot be deleted.** The correct action in that case is to disable it (`is_active = false`), which remains available regardless of order history.
- Branch codes are unique per business (case-sensitive, uppercase-letters-and-digits-only, 2–10 characters) and are embedded verbatim in order numbers.
- Branch creation requires all-branch access (an owner or an all-branch-scope manager) — a manager scoped to specific branches cannot create new branches.
- Managing (update/enable/disable/delete/restore) an existing branch requires that specific branch to be in the caller's scope; owners (all-branch scope) can manage every branch.
- Reading branch information (list, get) is business-wide regardless of the caller's own branch scope — deliberate, documented divergence from the orders branch-scope model (flagged for explicit product confirmation, not yet formally re-confirmed by the user post-Phase-4).
- `manager_user_id` on a branch is a **descriptive** field only (who runs it day to day) — it does **not** grant that user any permission scope. Access scope is set independently via `membership.branch_ids` through the team-invite flow. (Flagged for explicit product confirmation — not yet formally re-confirmed by the user.)
- Both latitude and longitude must be present together or not at all (never one without the other).

### Inventory (Phase 5) — IMPLEMENTED
- Every inventory item supports a barcode and is scannable via a normal phone camera on the frontend; the backend provides an exact-match scan-lookup endpoint (`GET /inventory/items/by-code/:code`) matching either the SKU or barcode column. A QR code is treated as a visual encoding of the same barcode value, not a second identifier — there is one `barcode` column, not two.
- The inventory catalog (`inventory_items`) is **business-scoped and shared across every branch**; per-branch quantities are **not stored anywhere** — they are computed as `SUM(quantity_delta)` from the movement ledger, grouped by `(branch_id, item_id)`. This directly reuses the lesson already applied to `customer_stats` (Decision #12): a stored, incrementally-updated quantity is exactly the shape of bug the original frontend prototype was most criticized for.
- Every stock movement (`inventory_movements`) is append-only, enforced by a database trigger — the same `enforce_append_only()` function already protecting `payments` and `order_status_history`, not new logic.
- Movement types are `receive` (+), `waste` (−, requires a reason), `adjust` (either direction, computed server-side from a stocktake count vs. current stock), `transfer_out`/`transfer_in` (a transfer is two linked rows sharing a `transfer_group_id`, not one row). Sign correctness and "no zero-quantity movements" are enforced by database CHECK constraints, not just application code.
- Branch scope for inventory is a **simple single-branch check** (confirmed by the user — Decision #18), not the Orders-style three-column OR predicate. Unlike Branches management, **stock reads are branch-scope-restricted, not business-wide** — a manager scoped to one branch cannot see another branch's stock levels or movement history. Catalog CRUD has no branch-scope check at all (it's business-wide, like the Orders `services` catalogue).
- SKU and barcode are unique **per business**, not globally (mirrors `branches.code`).
- An item cannot be deleted while it has nonzero stock at **any** branch — deliberately different from Branches' "any historical order blocks deletion" rule: Inventory blocks on *current holdings*, not on the mere existence of past movements, since blocking on any history would make almost every real item permanently undeletable.
- Waste and transfer-out are refused if they would drive stock below zero; adjust has no such guard, since correcting a known over-count downward is exactly what it exists to do.
- Receiving stock, recording waste, and adjusting stock require three separate permissions (`inventory.receive`, `inventory.waste_record`, `inventory.adjust` respectively) — mirroring how Orders' payment-recording and refunding are separate endpoints with separate permissions, not one generic endpoint.

### Inventory — NOT YET IMPLEMENTED (deliberately out of scope for Phase 5)
- Reorder thresholds / low-stock alerts.
- A formal stocktake/audit workflow (the `inventory.audit` permission remains reserved but unused).
- Order-triggered automatic stock consumption (Phase 3's `checkTransition()` already flags `triggersConsumption: true` on the transition to `ready`, explicitly left unwired pending a real inventory module — that module now exists, but the connection was not built this phase).

### Business Settings & Branding (Phase 6) — IMPLEMENTED
- **Exactly one settings record per business**, enforced by `UNIQUE(business_id)` on the new `business_settings` table — not zero, not many. Every business gets its row from the signup transaction (new businesses) or a one-time migration backfill (businesses that existed before Phase 6), so the invariant has no gap window.
- Settings are presented as **one unified resource spanning two physical tables**: the pre-existing `businesses` columns from Phase 0 (name, trade licence number, tax registration number, currency, language/`default_locale`, timezone) plus the new `business_settings` table (legal name, VAT/express rates, branding, contact info). The API consumer never needs to know or care which table a given field lives on — `GET /settings/business` returns one flat object, `PATCH /settings/business` accepts one flat partial object, and the service layer routes each field to the correct table transparently, inside one transaction.
- **VAT and express-surcharge rates are no longer hardcoded anywhere.** `orders/service.ts`'s four duplicated literals (`vatPct: 5`, `expressPct: ... 50`) are gone; both call sites (`createOrder`, `updateOrderLines`) now read `vat_enabled`/`vat_pct`/`express_pct` via `orders/repository.ts`'s `findBusinessSettings()`, extended in this phase to INNER JOIN `business_settings`. **Same-day follow-up: `deliveryFee` was found still hardcoded (`? 10 : 0`) during the pre-phase audit, flagged as out of scope for the field list as originally requested, then explicitly approved for closure (Option A) the same day.** `business_settings.delivery_fee` (migration `0011`, default `15.00` — matching the *frontend's* default, not the backend's old `10` literal) closes it the same way, through the same already-extended `findBusinessSettings()`. No hardcoded pricing literal of any kind remains in `orders/service.ts` as of this entry — see Decision #27.
- **An order snapshots its rate at creation time and keeps it even if settings change later** — this is not new behavior, just the existing snapshot pattern (Decision Log, Phase 3) now fed by a configurable source instead of a literal. **Editing an existing order's lines re-prices using the CURRENT settings, not the original snapshot** — also not new behavior; `updateOrderLines` already re-fetched business settings before this phase, it just fetched hardcoded values before. Both behaviors are tested explicitly in `settings.test.ts`.
- Disabling VAT (`vat_enabled: false`) zeroes both the rate and the computed amount on a new order — tested explicitly.
- Branding fields (`logo_url`, `favicon_url`) are **URL-reference columns only, not a file-upload feature** — consistent with every other "photo"-shaped field in this schema (`customers`, `branches`). Actual presigned-upload infrastructure remains the same standing, cross-module gap it's been since Phase 2.
- `theme` is a strict `'light' | 'dark'` enum — deliberately narrower than an initial draft's `'light' | 'dark' | 'auto'`, trimmed to match the literal two-option spec rather than left more permissive than asked.
- Currency/timezone/language validation is intentionally **shape-only, not an exhaustive fixed list** — `currency` checks for a 3-letter code (matching `businesses.currency`'s own lack of a DB-level CHECK), `timezone` checks for an IANA-name-*like* shape rather than validating against the full tzdata list (which would go stale), `language` is a strict `en`/`ar` enum (the only two locales this bilingual-only system has anywhere).
- No new permission strings were needed — `settings.read` and `settings.business.edit` were both already reserved in the Phase 0 catalogue (the latter was already gating `POST /services`, which remains true; a business-profile edit and a price-catalogue edit now legitimately share one permission).

### Delivery & Driver Management (Phase 7) — IMPLEMENTED
- **Every driver has a normal user account** (final decision) — `drivers.user_id` is a required FK to `users`, not nullable. A driver row is the delivery-specific extension of an existing user (vehicle info, live status), the same relationship `branches.manager_user_id` already has to `users`, just required here instead of optional. Driver identity (name, email, phone) is pulled from the joined `users` row at read time — never duplicated onto `drivers`.
- **Every delivery job MUST reference an existing order** (final decision, no exceptions) — `delivery_jobs.order_id` is NOT NULL. A cancelled or lost order cannot have a job created against it.
- **`delivery_jobs.branch_id` is derived, never client-supplied** — computed server-side as `order.collection_branch_id ?? order.intake_branch_id`, the *exact* expression `orders/service.ts`'s `recordPayment` already uses to attribute a payment's branch. Reused, not reinvented.
- **Vehicle information is limited to exactly three fields** (final decision): `vehicle_type` (bike/car/van), `plate_number`, `notes`. No richer vehicle model.
- **No separate job numbering in v1** (final decision) — a job is identified by its own numeric id and the order it belongs to; no gapless-sequence requirement the way orders/invoices have.
- **GPS is optional, captured once, at the physical event** — one pair of nullable columns (`proof_latitude`/`proof_longitude`) covers both job types (pickup location for a pickup job, delivery location for a delivery job), captured at completion alongside photo/signature proof. Never required — "optional if location permission is unavailable" (final decision).
- **Delivery jobs use soft delete** (final decision — reverses the design document's original recommendation to rely on `cancelled` status alone). `deleted_at` and the `cancelled` status **coexist**, mirroring `orders`, which already has both a `cancelled`/`lost` status enum and its own independent `deleted_at` column serving a different purpose.
- **Both `failed` and `cancelled` require a reason** — a CHECK constraint on `delivery_jobs.fail_reason` (extended during implementation verification to cover both statuses, not just `failed` as originally drafted — matches `orders.cancel_reason`'s precedent of one column covering two related terminal-negative outcomes).
- **The delivery fee is snapshotted from `business_settings.delivery_fee` at job creation**, for `job_type = 'delivery'` only (`pickup` jobs stay at fee `0`) — immutable thereafter, the same snapshot discipline `orders.vat_pct`/`orders.express_pct`/`orders.delivery_amount` already use, now applied to the exact setting Phase 6 made configurable.
- **Cash-on-delivery reuses Orders' own payment logic — not a duplicate implementation** (final decision, explicitly instructed: "do not duplicate payment logic"). Completing a job with a `collected_amount` calls `orders/service.ts`'s `recordPaymentInTx` directly, inside the *same* transaction as the job completion — the first time in this codebase one module's service function calls directly into another's (every prior cross-module interaction was a read). Reuses Orders' exact outstanding-balance guard; a collection attempt exceeding what the order actually owes is refused by that reused guard, not a second, parallel one.
- **Branch scope for jobs follows the Inventory model** (final decision: "keep the existing branch-scope model unchanged," i.e. reuse a proven shape rather than invent a fourth) — both reads and writes require the target branch to be in the caller's scope. **Drivers are business-scoped**, no branch dimension at all, same as the `services` catalogue.
- **Self scope — the one genuinely new authorization concept this module adds.** A driver acting on a job assigned to them is authorized regardless of branch scope, as long as the job is actually assigned to that specific person (`auth.userId` matching the assigned driver's `user_id`). Deliberately kept out of RLS (depends on a join RLS's simple tenant predicate isn't suited to) and out of the declarative `authorize()` middleware (which is strictly AND-only by design) — lives entirely in the service layer, mirroring where branch-scope decisions already lived.
- A driver with an active job assignment cannot be deleted, only disabled — mirrors the delete-guard pattern already used for branches (historical orders) and inventory items (current stock).
- Job status follows a fixed forward-only sequence: `scheduled → assigned → en_route → arrived → completed`, with `failed`/`cancelled` reachable from any non-terminal state. `cancelled` is dispatcher-only (`delivery.dispatch`), never driver-callable.
- Assigning a driver auto-sets their status to `busy`; completing or failing a job auto-releases them back to `available` **only if no other active job remains assigned** — a driver with two concurrent jobs stays `busy` until both are resolved.

---

## 5. Database

*Every table currently in the schema, in migration order. RLS column notes which tables have Row-Level Security (⚠ = deliberately without RLS, with reason).*

| Table | Migration | Description | Key relationships | RLS |
|---|---|---|---|---|
| `businesses` | 0002 | Tenant root — one row per laundry business | Referenced by nearly every other table via `business_id` | RLS on itself (`id = current_business_id()`) |
| `users` | 0002 | Global user identity (login credentials) | Referenced by `memberships`, `refresh_tokens`, and `*_by_user_id` provenance columns everywhere | ⚠ No RLS — users are global, not tenant-owned; access is gated through `memberships` |
| `roles` | 0002 | Named permission bundles, per business | `business_id` FK; referenced by `memberships.role_id` | ✅ |
| `branches` | 0002 (base), extended 0008 | Physical shop locations; extended in Phase 4 with email, lat/lng, manager_user_id, sort_order, provenance columns | `business_id` FK; referenced by `orders` (×3), `payments`, `order_status_history`, counters | ✅ |
| `memberships` | 0002 | Junction: user × business × role × branch scope | FKs to `users`, `businesses`, `roles`; carries `branch_ids: number[]` | ✅ |
| `refresh_tokens` | 0003 | Hashed opaque refresh tokens, family-based rotation | FK to `users` | ⚠ No RLS — a session belongs to a user, not a tenant |
| `activity_logs` | 0003 | Append-only audit trail (trigger-enforced immutability) | `business_id` FK; polymorphic `resource_type`/`resource_id` | ✅ |
| `password_resets` | 0004 | Hashed, single-use, expiring password reset tokens | FK to `users` | ⚠ No RLS — pre-auth, tied to a user not a tenant |
| `email_verifications` | 0004 | Hashed, single-use, expiring email verification tokens | FK to `users` | ⚠ No RLS — same reason |
| `customers` | 0005 | Business-scoped customer records, bilingual name/address, full-text search vector | `business_id` FK; `preferred_branch_id` FK | ✅ |
| `customer_notes` | 0005 | Free-text notes attached to a customer, pinnable | `customer_id` FK, `business_id` FK | ✅ |
| `customer_stats` (view) | 0005 | Aggregated lifetime stats per customer (currently zero-valued placeholder — see Known Limitations) | Derived from `customers` (join to `orders` planned, not yet wired) | N/A (view) |
| `services` | 0006 | Business-scoped price-catalogue service definitions (e.g., "Shirt Wash") | `business_id` FK | ✅ |
| `service_variants` | 0006 | Priced size/type variants of a service | `service_id` FK, `business_id` FK | ✅ |
| `orders` | 0007 | Core order record; branch triple, pricing snapshot, status, customer snapshot | `business_id`, `intake_branch_id` (NOT NULL), `processing_branch_id`, `collection_branch_id`, `customer_id` (nullable — walk-ins) | ✅ |
| `order_lines` | 0007 | Line items on an order, priced at time of order | `order_id` FK, `service_variant_id` FK | ✅ |
| `payments` | 0007 | Append-only payment/refund ledger (refunds are negative rows, never edits) | `order_id`, `branch_id`, `business_id` FKs | ✅, append-only trigger |
| `order_status_history` | 0007 | Append-only status transition log | `order_id`, `branch_id`, `business_id` FKs | ✅, append-only trigger |
| `order_photos` | 0007 | Table exists (schema only); no repository/service/route code uses it yet | `order_id` FK | ✅ |
| `order_number_counters` | 0007 | Branch-scoped, daily-reset sequence for order numbers | `(business_id, branch_id, local_date)` composite PK | ✅ |
| `invoice_number_counters` | 0007 | Business-scoped, yearly-reset gapless sequence for invoice numbers | `(business_id, year)` composite PK | ✅ |
| `inventory_items` | 0009 | Business-scoped shared catalog, bilingual name, SKU/barcode (unique per business), full-text search vector | `business_id` FK | ✅ |
| `inventory_movements` | 0009 | Append-only ledger; the sole source of truth for stock — no quantity is stored anywhere else | `business_id`, `branch_id` (NOT NULL), `item_id` FKs | ✅, append-only trigger |
| `inventory_stock_levels` (view) | 0009 | Current on-hand quantity per (branch, item), computed as `SUM(quantity_delta)` — never stored | Derived from `inventory_movements` | N/A (view) |
| `business_settings` | 0010, extended 0011 | Business-scoped, exactly one row per business (`UNIQUE(business_id)`); legal name, VAT/express/delivery rates, branding, contact info — the fields `businesses` doesn't already cover | `business_id` FK (`ON DELETE CASCADE`) | ✅ |
| `drivers` | 0012 | Business-scoped; the delivery-specific extension of an existing user (required `user_id` FK, vehicle info, live status) — identity itself lives on `users`, never duplicated | `business_id`, `user_id` (required) FKs | ✅ |
| `delivery_jobs` | 0012 | Branch-scoped (branch derived from the linked order, never client-supplied); every job requires an order; soft-delete + `cancelled` status coexist, mirroring `orders` | `business_id`, `branch_id`, `order_id` (required), `driver_id` (nullable) FKs | ✅ |
| `delivery_job_status_history` (append-only) | 0012 | Mirrors `order_status_history` exactly — every job status transition, immutable | `business_id`, `job_id`, `branch_id` FKs | ✅, append-only trigger |

**Migration count: 12 files** (`20260810_0001` through `20260810_0012`). **RLS policy count: 22 `tenant_isolation` policies** (19 through Phase 6 + 3 new for `drivers`/`delivery_jobs`/`delivery_job_status_history`). **Append-only trigger attachments: 10** (2 each on `activity_logs`, `payments`, `order_status_history`, `inventory_movements`, and now `delivery_job_status_history` — the fifth table to reuse `enforce_append_only()`, verified by two dedicated negative tests rather than inherited trust from an earlier phase's proof against a different table).

**`businesses` (Phase 0) was left completely schema-untouched by Phase 6** — no new columns, no migration against it at all. Six of its existing columns (`name`, `trade_licence_number`, `tax_registration_number`, `currency`, `default_locale`, `timezone`) became *writable* for the first time (via `PATCH /settings/business`, added this phase), but the table definition itself is exactly what it was in Phase 0.

---

## 6. API Summary

**Total endpoints implemented: 86** (verified by grep against each module's `routes.ts`, accounting for Fastify's generic-typed route syntax which plain-text grep can miss — see the `DELETE /me/sessions/:id` correction noted in §14).

### Auth (`/auth/*`, `/me*`) — 12 endpoints
```
POST   /auth/signup                    PUBLIC
POST   /auth/login                     PUBLIC
POST   /auth/refresh                   PUBLIC (refresh cookie)
POST   /auth/logout                    PUBLIC (refresh cookie)
POST   /auth/logout-all                authenticated
POST   /auth/password/reset-request    PUBLIC
POST   /auth/password/reset-confirm    PUBLIC
POST   /auth/email/resend              authenticated
POST   /auth/email/verify              PUBLIC
GET    /me                             authenticated
GET    /me/sessions                    authenticated
DELETE /me/sessions/:id                authenticated
```

### Team (`/team*`) — 3 endpoints
```
GET    /team                           authenticated
POST   /team/invite                    settings.roles.edit
POST   /team/accept                    PUBLIC (invite token)
```

### Customers (`/customers*`) — 12 endpoints
```
GET    /customers                      customers.read
POST   /customers                      customers.create
GET    /customers/statistics           customers.read
GET    /customers/:id                  customers.read
PATCH  /customers/:id                  customers.update
POST   /customers/:id/status           customers.update
DELETE /customers/:id                  customers.delete
POST   /customers/:id/restore          customers.delete
GET    /customers/:id/activity         customers.read + activity_log.read
GET    /customers/:id/notes            customers.read
POST   /customers/:id/notes            customers.update
DELETE /customers/:id/notes/:noteId    customers.update
```

### Orders & Services (`/orders*`, `/services*`) — 11 endpoints
```
GET    /services                       orders.read
POST   /services                       settings.business.edit
GET    /orders                         orders.read
POST   /orders                         orders.create
GET    /orders/:id                     orders.read
PATCH  /orders/:id/lines               orders.update
PATCH  /orders/:id                     orders.update
POST   /orders/:id/status              orders.status_change
POST   /orders/:id/payments            orders.payment_record
POST   /orders/:id/refund              orders.refund
DELETE /orders/:id                     orders.delete
```

### Branches (`/branches*`) — 7 endpoints
```
GET    /branches                       settings.read
POST   /branches                       settings.branches.edit (+ all-branch scope)
GET    /branches/:id                   settings.read
PATCH  /branches/:id                   settings.branches.edit (+ target-branch scope)
POST   /branches/:id/status            settings.branches.edit (+ target-branch scope)
DELETE /branches/:id                   settings.branches.edit (+ target-branch scope)
POST   /branches/:id/restore           settings.branches.edit (+ target-branch scope)
```

### Health (`/health/*`) — 2 endpoints
```
GET    /health/live                    PUBLIC
GET    /health/ready                   PUBLIC
```

### Business Settings (`/settings/*`) — 2 endpoints
```
GET    /settings/business              settings.read
PATCH  /settings/business               settings.business.edit
```
A singleton resource — no `:id` in either path. There is exactly one settings record per business, scoped implicitly by the caller's `auth.businessId` from the JWT, never a client-supplied value. Response fields span two physical tables (`businesses`, `business_settings`) but are always presented as one flat object; see §4 and §11 (Decisions #23–25) for why.

### Inventory (`/inventory*`) — 16 endpoints
```
GET    /inventory/items                          inventory.read
POST   /inventory/items                          inventory.adjust
GET    /inventory/items/by-code/:code            inventory.read
GET    /inventory/items/:id                      inventory.read
PATCH  /inventory/items/:id                      inventory.adjust
POST   /inventory/items/:id/status               inventory.adjust
DELETE /inventory/items/:id                      inventory.adjust
POST   /inventory/items/:id/restore              inventory.adjust
GET    /inventory/items/:id/stock                inventory.read (scope-filtered)
GET    /inventory/items/:id/movements            inventory.read (scope-filtered)
GET    /inventory/branches/:branchId/stock       inventory.read (+ target-branch scope)
GET    /inventory/branches/:branchId/movements   inventory.read (+ target-branch scope)
POST   /inventory/branches/:branchId/receive     inventory.receive (+ target-branch scope)
POST   /inventory/branches/:branchId/waste       inventory.waste_record (+ target-branch scope)
POST   /inventory/branches/:branchId/adjust      inventory.adjust (+ target-branch scope)
POST   /inventory/transfer                       inventory.adjust (+ both branches scope)
```

### Delivery (`/delivery*`) — 21 endpoints
```
GET    /delivery/drivers                         delivery.read
POST   /delivery/drivers                         delivery.dispatch
GET    /delivery/drivers/:id                     delivery.read
PATCH  /delivery/drivers/:id                     delivery.dispatch
POST   /delivery/drivers/:id/status              delivery.read (+ self-or-dispatch, service-layer)
DELETE /delivery/drivers/:id                     delivery.dispatch
POST   /delivery/drivers/:id/restore             delivery.dispatch
GET    /delivery/drivers/:id/jobs                delivery.read (self-scope for the driver, branch-scope otherwise)
POST   /delivery/jobs                            delivery.dispatch (+ branch scope, derived from the order)
GET    /delivery/branches/:branchId/jobs         delivery.read (+ target-branch scope)
GET    /delivery/orders/:orderId/jobs            delivery.read
GET    /delivery/jobs/:id                        delivery.read (+ branch scope OR self-scope)
PATCH  /delivery/jobs/:id                        delivery.dispatch (+ branch scope)
POST   /delivery/jobs/:id/assign                 delivery.assign_driver (+ branch scope)
POST   /delivery/jobs/:id/status                 delivery.execute (+ self-scope OR branch scope)
POST   /delivery/jobs/:id/complete               delivery.complete (+ self-scope OR branch scope)
POST   /delivery/jobs/:id/fail                   delivery.fail (+ self-scope OR branch scope)
POST   /delivery/jobs/:id/cancel                 delivery.dispatch (+ branch scope) — dispatcher-only
DELETE /delivery/jobs/:id                        delivery.dispatch (+ branch scope)
POST   /delivery/jobs/:id/restore                delivery.dispatch (+ branch scope)
GET    /delivery/jobs/:id/history                delivery.read (+ branch scope OR self-scope)
```
**Note on `POST /delivery/drivers/:id/status`:** the route-level gate is deliberately coarse (`delivery.read`, the one permission every relevant role shares) — the real decision ("is this caller the driver in question, or do they hold `delivery.dispatch`") is service-layer logic, not a static permission list, because `authorize()` is strictly AND-only and cannot express "execute OR dispatch" declaratively. See Decisions Log #28 for why, including the bug this caused before it was found and fixed.

**Permission catalogue: 52 permission strings** across 12 domains — unchanged since Phase 4; no new permission strings were needed for Phase 5, 6, or 7. Phase 5 activated 4 of the 6 already-reserved `inventory.*` permissions (`read`, `adjust`, `receive`, `waste_record`); `inventory.audit` and `inventory.recipe_edit` remain reserved-but-unimplemented. Phase 6 activated 2 already-reserved `settings.*` permissions (`read`, `business.edit`) — the latter was already in use gating `POST /services` and now also gates settings edits, a deliberate, reasonable overlap (both are genuinely business-settings-shaped actions). **Phase 7 activated all 6 `delivery.*` permissions** — the first domain in this project to go from fully-reserved to fully-used in one phase. `settings.integrations.edit` and `notifications.*` remain reserved-but-unimplemented, the same status `purchasing.*`/`reports.*` now have (delivery having retired its own reserved list).

---

## 7. Completed Phases

### Phase 0 — Backend Foundation
- **Goal:** Project skeleton, Postgres/Redis connectivity, RLS foundation, config validation, health checks, migration runner. No business modules.
- **Files created:** ~26 files — `src/config/{env,logger}.ts`, `src/lib/{db,db-schema,errors,jwt,migrate,passwords}.ts`, `src/middleware/{error-handler,request-id}.ts`, `src/modules/health/routes.ts`, `src/shared/{permissions,types}.ts`, `src/api.ts`, `src/main.ts`, `docker-compose.yml`, `package.json`, `tsconfig.json`, `.env.example`, `README.md`.
- **Migrations:** `0001_extensions_and_functions` (citext/pgcrypto extensions, `normalize_arabic()` function, `trg_updated_at()`, `enforce_append_only()`), `0002_tenancy` (businesses, users, roles, branches, memberships + RLS), `0003_auth_and_audit` (refresh_tokens, activity_logs + append-only trigger).
- **APIs:** `/health/live`, `/health/ready`, root `/`.
- **Tests:** 11 unit tests (`test/integration/foundation.test.ts`) — permission catalogue integrity, Argon2id hash/verify, JWT sign/verify/tamper-rejection.
- **Security work:** Argon2id with tunable parameters; constant-time login (dummy-hash verify prevents user enumeration by timing); HS256-refused-in-production config guard; log redaction of all sensitive fields; structured `{code, message, details?}` error shape everywhere.
- **Important decisions:** Kysely over Prisma (RLS compatibility); shared-schema-with-RLS over database-per-tenant; `users`/`refresh_tokens` deliberately outside RLS.
- **Known limitations at close:** No auth endpoints yet (deliberately deferred to Phase 1); HS256-only JWT signer (RS256 deferred); no CI/CD.

### Phase 1 — Authentication and Identity
- **Goal:** Full auth lifecycle — signup, login, logout, refresh rotation, password reset, email verification, session management, team invites, permission enforcement.
- **Files created:** `src/lib/{redis,tokens,refresh-cookie,audit}.ts`, `src/middleware/{authenticate,authorize}.ts`, `src/modules/auth/{service,routes,schemas}.ts`, `src/modules/team/{service,routes}.ts`.
- **Migrations:** `0004_password_resets_and_email_verifications`.
- **APIs:** 12 auth endpoints + 3 team endpoints (see §6).
- **Tests:** 46 new regression tests across 7 files — `tenant-isolation`, `brute-force-lockout`, `refresh-rotation`, `password-reset`, `append-only-audit`, `authorize`, `log-redaction`, `headers-and-errors`, `config-validation`. Project total went from 11 → 57 tests.
- **Security work:** 17 OWASP controls moved from 🟡/❌ to ✅ Verified (code + passing test) in this phase — see `PHASE-1-REPORT.md` §5 for the full before/after table. Refresh token family-based reuse detection implemented and tested (stealing a rotated-out token revokes the whole session tree). Audit-log writer (`auditInTx`) wired into every state-changing endpoint.
- **Important decisions:** Refresh tokens stored as SHA-256 hashes, never plaintext; a 5-second idempotency window planned (not yet built) for concurrent refresh races; team invites reuse the `password_resets` token mechanism rather than a dedicated `invitations` table (explicitly flagged as a trade-off in the code, to be revisited if the invite flow grows more features).
- **Known limitations at close:** MFA schema exists (`users.mfa_secret`) but is unencrypted and has no enrollment/verify endpoints — explicitly deferred, not silently dropped. RS256 JWT signing still not implemented (HS256 remains dev-only). No CI dependency scanning. Password reset emails are not actually sent — logged to console in dev only (blocks real customer onboarding until Phase 6/notifications).

### Phase 2 — CRM Backend (Customers Module)
- **Goal:** Full customer management backend — CRUD, bilingual search, filtering/sorting, pagination, notes, status lifecycle, soft delete/restore, audit trail.
- **Files created:** `src/modules/customers/{repository,service,schemas,routes}.ts`.
- **Migrations:** `0005_customers` (customers, customer_notes, customer_stats view, full-text search via generated `tsvector` column).
- **APIs:** 12 customer endpoints (see §6).
- **Tests:** 56 new test blocks across 3 files — `customers-isolation`, `customers-authz`, `customers.test` (functional). Project total: 57 → ~113.
- **Security work:** RLS + IDOR tests proving cross-tenant access always 404s, never 403s; 6 SQL injection payloads tested against search with table-integrity verification; XSS payload round-trip test (stored/returned as inert JSON); every mutation confirmed to write an audit row with a before/after diff containing only changed fields.
- **Important decisions:** Customer aggregates (`spend`, `outstanding`, `orders_count`, etc.) are a **view returning zero placeholders**, not stored columns updated by delta arithmetic — this is the direct fix for the single most-cited fragility in the original frontend engineering audit. The view's real computation is deferred to Phase 3+ (when `orders`/`payments` exist) with **no endpoint contract change needed** when that lands. Arabic search uses the same `normalize_arabic()` function as the frontend's client-side `normalize()`, so "احمد" (plain alef) correctly matches "أحمد" (hamza alef) — tested explicitly.
- **Known limitations at close:** `hasDebt` filter is accepted by the schema but is a documented no-op (applying it before `customer_stats` is real would silently return nothing, which is worse than ignoring it). Customer deletion does not check for unpaid orders (deliberately absent, not stubbed — the check belongs once `orders` exists). No presigned-upload flow for customer photos yet (`photo_url` is a plain string field). Name-sort pagination has weaker cursor guarantees than the default created_at sort (flagged, not yet fixed).

### Phase 3 — Orders Module (Branch-Aware Architecture)
- **Goal:** Order intake, pricing, status lifecycle, payments/refunds, order+invoice numbering — built against a user-approved branch-aware architecture (see §11 Decisions Log for the full trade-off discussion that preceded this phase).
- **Files created:** `src/modules/orders/{branch-scope,numbering,pricing,transitions,repository,schemas,service,routes}.ts`.
- **Migrations:** `0006_services` (price catalogue), `0007_orders` (orders, order_lines, payments, order_status_history, order_photos, order_number_counters, invoice_number_counters).
- **APIs:** 11 endpoints (see §6).
- **Tests:** 66 new test blocks across 3 files — `orders-isolation` (RLS + branch OR-logic + IDOR), `orders-authz` (permissions, client-money-trust, injection), `orders.test` (pricing/transitions/numbering/payments functional). Project total: ~113 → ~179.
- **Security work:** The refund-laundering vulnerability class explicitly closed and tested (a refund must reference a payment belonging to the *same* order in the URL, not merely a payment the caller can see). Invoice gaplessness proven with an actual cancelled order interleaved between two delivered ones (not just format-matched). Server-side pricing enforced by strict schema rejection of client-supplied money fields, with a dedicated test proving the computed total ignores a client hint.
- **Important decisions:** Branch-scope enforcement is application-layer, not RLS (full reasoning replicated into `orders/branch-scope.ts`'s header comment). Order numbering and invoice numbering use hand-rolled transactional counters (`INSERT ... ON CONFLICT DO UPDATE ... RETURNING`) rather than Postgres sequences, specifically because sequences are non-transactional and UAE FTA requires invoice numbers to be gapless — a rolled-back order must not have burned a number.
- **Known limitations at close:** **No Branches CRUD endpoint existed yet** — every multi-branch test had to insert a second branch via raw SQL (this was the top-flagged risk going into Phase 4, and Phase 4 resolved it). Inventory consumption on order completion is a documented gap (`checkTransition` returns a `triggersConsumption` flag that nothing consumes yet). Express/VAT rates are hardcoded per-business, not configurable per-branch. `order_photos` table exists with no code using it. No rate limiting on order endpoints. `updateOrderMeta` (notes/due-date) has no edit-lock check, unlike `updateOrderLines` — flagged as a decision needing an explicit call, not yet resolved.

### Phase 4 — Branches Management
- **Goal:** Full branch CRUD, enable/disable, soft-delete-blocked-by-historical-orders, restore, geo/contact/working-hours fields, manager assignment — resolving Phase 3's top-flagged risk.
- **Files created:** `src/modules/branches/{branch-scope,repository,service,schemas,routes}.ts`.
- **Migrations:** `0008_branches_management` — `ALTER TABLE branches ADD COLUMN` for email, latitude/longitude (paired CHECK constraint), manager_user_id, sort_order, and provenance columns. (The `branches` table itself, its RLS policy, and its soft-delete/unique-code constraints already existed from Phase 0 — this migration *extended* rather than redefined it, verified before writing anything.)
- **APIs:** 7 endpoints (see §6).
- **Tests:** 62 new test blocks across 3 files — `branches-isolation`, `branches-authz`, `branches.test` (functional). Project total: ~179 → ~241.
- **Security work:** The historical-orders delete-guard tested for the non-obvious case — a branch that was only ever a *processing* branch (never intake) still correctly blocks deletion, proving the check covers all three branch columns, not just the obvious one. A "scope, not role" test proves an all-branch-scoped *manager* (not the owner role) can create branches, while a single-branch-scoped manager cannot.
- **Important decisions:** `manager_user_id` is **descriptive only** — it does not grant permission scope; that stays a separate action via the team-invite flow's `membership.branch_ids`. Branch *metadata* is readable business-wide regardless of the caller's own branch scope (a deliberate divergence from the orders OR-logic read model). **Both of these are flagged in `PHASE-4-REPORT.md` §8 as product decisions needing explicit user confirmation — not yet formally re-confirmed as of this document's writing.**
- **Known limitations at close:** No "branches I manage" filtered endpoint. Working hours have no explicit timezone marker (implicitly assumed to be the business's timezone — fine for a UAE-only reality, would need revisiting for a cross-timezone chain). No "is this branch open right now" computed endpoint. No bulk-reorder endpoint for `sort_order` (fine at current scale — single PATCH per branch).

### Phase 5 — Inventory
- **Goal:** Barcode/QR-scannable catalog items, a business-wide shared catalog with per-branch stock quantities, fully immutable/traceable movement logs — the four requirements stated verbatim in the prior session and recorded in §4/§9 before this phase started.
- **Files created:** `src/modules/inventory/{branch-scope,repository,service,schemas,routes}.ts`.
- **Migrations:** `0009_inventory` — `inventory_items` (business-scoped catalog with generated search vector), `inventory_movements` (append-only ledger reusing the Phase 0/1 `enforce_append_only()` trigger), `inventory_stock_levels` (a computed view, not a stored column — see Decision #19).
- **APIs:** 16 endpoints (see §6).
- **Tests:** 72 new test blocks across 3 files — `inventory-isolation` (RLS + branch-scope, including the deliberate divergence where stock reads ARE scope-restricted unlike Branches), `inventory-authz` (permissions, validation, injection — including the scan-lookup endpoint tested with the same SQL payloads as search, since it's the endpoint most likely to receive raw camera-decoded input), `inventory.test` (functional, organised directly around the 4 stated requirements). Project total: **318 test blocks, 19 → 23 test files** (19 → 20 after the intervening customer-deletion fix, → 23 after this phase's 3 new files) — verified by a fresh `grep` count against every file rather than carried forward arithmetically; a prior running total had drifted by one block somewhere before this phase, corrected here rather than propagated.
- **Security work:** Stock sign convention (`receive`>0, `waste`<0, `transfer_out`<0, `transfer_in`>0) and "no zero-quantity movements" both enforced by database CHECK constraints, not just application code. The append-only trigger tested directly against this specific table (UPDATE and DELETE both rejected), not just inherited by trust from Phase 1's proof against a different table. The delete-guard tested for the non-obvious case: stock at a branch *other than the one checked first* still blocks deletion, proving the guard sums across all branches.
- **Important decisions:** Confirmed by the user before the migration was written: single-branch scope model (Decision #18). Made during the phase: stock levels are a computed view, never a stored column (Decision #19, directly reusing the `customer_stats` lesson); a transfer is two rows correlated by a shared UUID, not a self-referencing FK (Decision #20); the item-deletion guard blocks on *current stock*, not on *any historical movement* — a deliberate, documented divergence from Branches' "any historical order blocks deletion" rule (Decision #21); three separate movement endpoints rather than one generic type-dispatched endpoint, mirroring the Orders payments/refund precedent (Decision #22); stock reads are branch-scope-restricted while catalog reads are business-wide, two different rules applied deliberately within the same module (Decision #18, extended).
- **Known limitations at close:** Reorder/low-stock alerting not built (not part of the 4 stated requirements). No formal stocktake/audit workflow (`inventory.audit` reserved but unused). Order-triggered automatic consumption remains unwired — Phase 3's `triggersConsumption` flag still has nothing listening to it; the module that would consume it now exists but the connection wasn't built this phase. No presigned-upload path for item photos (same standing gap as customers/branches). No standard-cost comparison or anomaly flagging on `unit_cost`. No rate limiting on any inventory endpoint (standing gap since Phase 2).

### Phase 6 — Business Settings & Branding
- **Goal:** One settings module as "the single source of truth for all business configuration" — business information (name, legal name, trade license, tax registration, VAT %, express surcharge, currency, language, timezone), branding (logo, favicon, primary/secondary color, light/dark theme, receipt header/footer), and contact information (address, phone, email, website, social links). Explicit requirement: no hardcoded VAT or express percentages anywhere after this phase.
- **Pre-implementation audit:** A full, code-verified audit (`PRE-PHASE-6-AUDIT.md`) preceded this phase, covering existing modules, schema, tenant architecture, existing settings-adjacent code, frontend assumptions, security patterns, and risks — approved by the user before any code was written. The audit's central finding drove this phase's design: `orders/service.ts` already had four duplicated hardcoded literals (`vatPct: 5`, `expressPct: 50`) at exactly the two call sites that already called a `findBusinessSettings()` repository function — meaning the wiring point was already half-built, not designed from scratch. The frontend prototype's four independent local `DEFAULT_SETTINGS` objects independently confirmed the same numbers, and confirmed real, pre-existing demand for a real settings object.
- **Files created:** `src/modules/settings/{repository,service,schemas,routes}.ts`.
- **Files modified:** `src/modules/orders/repository.ts` (`findBusinessSettings()` extended, not replaced, to INNER JOIN the new table and return `vatEnabled`/`vatPct`/`expressPct`), `src/modules/orders/service.ts` (all four hardcoded literals replaced with the extended function's return values, at both `createOrder` and `updateOrderLines`), `src/modules/auth/service.ts` (`signupOwnerAndBusiness` now also inserts the one required `business_settings` row, in the same transaction as the business itself).
- **Migrations:** `0010_business_settings` — one new table, 1:1 with `businesses` via `UNIQUE(business_id)`. `businesses` itself was not altered. A backfill `INSERT ... SELECT ... ON CONFLICT DO NOTHING` gives every pre-existing business a settings row at defaults matching the literals being deleted, so no existing business's pricing behavior changes.
- **APIs:** 2 endpoints (see §6) — `GET`/`PATCH /settings/business`, a singleton resource with no `:id`, presenting fields from two physical tables as one flat object.
- **Tests:** 45 new test blocks across 3 files — `settings-isolation` (RLS proof, both DB- and HTTP-layer, plus a UNIQUE-constraint negative test), `settings-authz` (permission granularity, extensive field-level validation — VAT range, hex colors, theme enum, email/URL/currency/timezone/language shape, unknown social-platform-key rejection, business_id-override rejection — and injection resistance), `settings.test` (functional — the most important tests are in the "orders pricing reflects business settings" block: a changed VAT/express rate actually changes what a *new* order computes; an order created *before* a settings change keeps its original snapshotted rate; repricing an existing order's lines picks up the *current* rate, matching pre-existing `updateOrderLines` semantics unchanged in kind, just no longer hardcoded). Project total: 318 → **363** (23 → 26 test files).
- **Security work:** RLS + `FORCE ROW LEVEL SECURITY` on the new table, identical shape to all 18 prior policies. Every mutation writes one audit row (`business_settings.update`) diffed against the combined before/after view, regardless of which of the two underlying tables actually changed. `.strict()` Zod validation throughout, including an explicit test that an attempted `business_id` override in the PATCH body is rejected. No new permission strings — reused `settings.read`/`settings.business.edit`, both already reserved since Phase 0.
- **Important decisions:** New table (`business_settings`) rather than extending `businesses`, keeping the tenancy root schema-untouched (Decision #23). One unified flat resource spanning two tables, service-layer-merged, PATCH shape flat (not nested) to match every other module's convention (Decision #24). `findBusinessSettings()` extended in place rather than duplicated, INNER JOIN matching the same "fail loudly on a broken invariant" philosophy the settings module's own `getCombined()` established (Decision #25). `theme` trimmed from an initial three-value draft (`light`/`dark`/`auto`) to the literally-requested two (Decision #26).
- **A document-integrity issue was found and fixed during this phase's documentation pass, not introduced by it:** this file's Decisions Log entries #19–22 (from the Phase 5 update) had been accidentally duplicated with slightly different wording — not two historical events, one event written twice. De-duplicated in §11, noted transparently rather than silently.
- **Known limitations at close:** Logo/favicon are URL-reference fields only — no actual file-upload capability was built (matches the standing, cross-module gap already true for customers/branches). `settings.integrations.edit` and notification-preference permissions remain reserved but unused — out of scope per the approved audit. Currency/timezone validation is shape-only, not validated against an exhaustive real-world list (documented, deliberate trade-off, not an oversight). No endpoint-level rate limiting (standing gap since Phase 2).
- **Same-day follow-up (Option A):** the pre-phase audit's other finding — `deliveryFee` still hardcoded, out of scope for the original field list — was closed the same day per explicit approval. New migration `0011`, same wiring path as VAT/express, default `15` chosen to match the frontend rather than the backend's old `10` (a real, documented behavior change for existing businesses, unlike `0010`'s zero-behavior-change defaults). 11 new tests, no new files. Full detail in `PHASE-6-REPORT.md` §9 and the Decisions Log (#27).

### Phase 7 — Delivery & Driver Management
- **Goal:** give the `driver` system role (seeded, unused, since Phase 0) real endpoints; add accountability to the `out_for_delivery → delivered` transition Orders already modelled with none; build the backend counterpart to the frontend's fully-designed but unconnected dispatch UI.
- **Pre-implementation design document:** `PHASE-7-DESIGN.md`, preceded by a fresh audit that recommended Delivery over the three candidates `PROJECT_CONTEXT.md` §9 had carried since Phase 5 (order-triggered consumption, a stocktake workflow, reorder alerting) — found by the same method that surfaced Phase 6: an entire permission-catalogue domain (`delivery.*`, 6 permissions, assigned across 4 of 5 seeded roles) with zero implementing endpoints, verified by grep, not assumed. The design document's 7 open questions (branch-scope model, driver login requirement, mandatory order linkage, job soft-delete, cross-module payment reuse, vehicle field shape, job numbering) were all resolved by explicit user decision before any code was written — see Decisions Log #28 onward.
- **Files created:** `src/modules/delivery/{branch-scope,repository,service,schemas,routes,transitions}.ts`.
- **Files modified:** `src/modules/orders/service.ts` — `recordPayment` split into `recordPaymentInTx` (transaction-taking, newly exported) + `recordPayment` (unchanged 4-line public wrapper delegating to it) — the minimal mechanical change needed to let Delivery reuse the exact same outstanding-balance guard inside its own transaction, with zero behavior change for `orders/routes.ts`'s existing call site. `src/lib/db-schema.ts` (three new table types). `src/api.ts` (route registration). `test/helpers/harness.ts` (three new truncation entries, correct dependency order).
- **Migrations:** `0012_delivery` — `drivers` (business-scoped, required `user_id`, no duplicated identity data), `delivery_jobs` (branch-scoped, branch **derived** from the linked order via the same expression `recordPayment` already used, never client-supplied; every job requires an order; soft-delete and `cancelled` status coexist, mirroring `orders`), `delivery_job_status_history` (append-only, the fifth table to reuse `enforce_append_only()`).
- **APIs:** 21 endpoints (see §6) — the first domain to go from fully-permission-reserved to fully-used in one phase.
- **Tests:** 71 new test blocks across 3 files — `delivery-isolation` (RLS + branch-scope-per-the-Inventory-model + the new self-scope axis, including a dedicated regression block that directly proves a bug found during verification is fixed), `delivery-authz` (permission granularity across all 6 `delivery.*` permissions, validation, injection resistance), `delivery.test` (functional — driver CRUD and delete-guard, mandatory order linkage, derived branch_id, delivery-fee snapshot immutability, full job lifecycle, auto driver status management, cash-on-delivery calling Orders' reused guard directly with a dedicated test proving the *reused* guard fires rather than a new one, append-only history, soft delete). Project total: 374 → **445** (26 → 29 test files).
- **Security work — two real bugs found and fixed during this phase's own pre-completion verification, before any test existed to catch them by accident:**
  1. `POST /delivery/drivers/:id/status` was gated by `authorize(["delivery.execute", "delivery.dispatch"], { mode: "any" })` — a second argument `authorize()` has no parameter for (it is strictly AND-only by documented design). Silently ignored at runtime (JavaScript ignores extra arguments); would fail to type-check under `tsc`. Since no non-owner role holds both permissions, the endpoint was callable only by the owner — broken for its two actual intended callers. Fixed by moving the OR logic to the service layer, where it was already correctly written (`isSelf || auth.permissions.includes("delivery.dispatch")`), and loosening the route to a coarse `authorize(["delivery.read"])` gate.
  2. `branchIdParamSchema` was imported in `routes.ts` but never defined in `schemas.ts` — would have crashed the module at load time. Added it, matching the exact convention already used in Branches/Inventory.
  Both are documented in `OWASP-COMPLIANCE.md`'s new Phase 7 A01 addendum as direct evidence the continuous-review policy catches real issues, not just in principle.
- **Important decisions:** all consolidated in the Decisions Log (#28–#32) — the self-scope authorization axis (new, deliberately kept out of both RLS and the declarative permission middleware), the cross-module `recordPaymentInTx` split (first service-to-service call across a module boundary in this codebase, every prior cross-module interaction having been a read), the fail/cancel shared-reason-column fix, and the migration-editing-within-an-unshipped-phase precedent (matching how Phase 6's mid-build fixes were handled before that phase was ever presented as complete).
- **Known limitations at close:** OTP-based delivery verification (present in the frontend prototype, present in an earlier draft of the design document) was **deliberately dropped** — never part of the user's finalized decision list, correctly excluded rather than added as unrequested scope. No order-triggered automatic job creation (a natural future connection, explicitly out of scope this phase). No SMS/notification delivery of anything — matches the frontend's own dispatcher-facing design, not a gap. Presigned uploads remain the standing project-wide gap, now inherited by a fifth module (`proof_photo_url`/`proof_signature_url` are URL columns with no upload path). No rate limiting (standing gap since Phase 2).

---

## 8. Current Phase

**Phase 7 (Delivery & Driver Management) is complete and approved.** No phase is currently "in progress" as of this document's writing.

Product decisions still awaiting explicit confirmation, carried forward unresolved from Phase 4 (neither blocks any completed work, both should be resolved before frontend UI assumes an answer):
1. Whether `manager_user_id` should remain purely descriptive, or should auto-grant branch scope.
2. Whether branch metadata should stay business-wide-readable, or be narrowed to match the orders/inventory scope model.

**Next-phase direction is not yet chosen** — see §9.

---

## 9. Next Phase

**Not yet chosen.** The three candidates carried since Phase 5 remain exactly where they were — Phase 7 (like Phase 6 before it) was found by a fresh audit rather than picked from this list, and surfaced no further candidates of its own beyond what's already noted below:

1. **Order-triggered automatic stock consumption.** Phase 3's `checkTransition()` still returns `triggersConsumption: true` when an order moves to `ready`, unwired. Needs a recipe concept that doesn't exist yet; `inventory.recipe_edit` remains reserved-but-unused since Phase 0 for exactly this.
2. **A formal stocktake/audit workflow**, using the already-reserved `inventory.audit` permission.
3. **Reorder thresholds / low-stock alerting** — needs a decision on per-item vs. per-branch thresholds.

**A fourth, natural candidate is now more concrete than it was before Phase 7 existed:** order-triggered automatic delivery-job creation (an order reaching `ready` or `out_for_delivery` auto-spawning a job) — flagged as explicitly out of scope in `PHASE-7-DESIGN.md` §3 and §16, now buildable now that the Delivery module actually exists. Not yet scoped in any more detail than that one sentence.

**Worth doing before picking any of these: the same kind of fresh, explicit audit that surfaced both Phase 6 and Phase 7** — two phases in a row have now come from "what does the code and frontend already half-assume" rather than from this list, which is itself evidence the list may not be where the highest-value next work actually is.

Also outstanding, unrelated to which direction is picked next: the two Phase 4 product-decision confirmations noted in §8, and the standing infrastructure backlog in §13 (RS256, rate limiting beyond auth, CI/CD, backups — all untouched since first flagged, now including Phase 6 and Phase 7's own additions to that same backlog — see §12).

---

## 10. Security

*Permanent summary — updated after every phase. Full detail lives in `SECURITY.md` and `OWASP-COMPLIANCE.md`; this section is the always-current condensed version.*

**OWASP Top 10 (2021) compliance:** Tracked risk-by-risk in `OWASP-COMPLIANCE.md` with a strict rule — a control is only marked ✅ Verified if it has **both** code and a passing regression test; code alone is 🟡; a plan alone is ❌. As of end of Phase 1, that document recorded 2 risks (A02, A10) fully ✅ Verified and the rest 🟡/❌ with named target phases; **this document has not yet been re-run against Phases 2–5's additions** — updating `OWASP-COMPLIANCE.md` itself against the current test suite is outstanding work (see §13 TODO). What *is* current: every phase since has added dedicated regression tests for RLS isolation, IDOR resistance, permission enforcement, and injection resistance on every new module, following the exact evidence discipline OWASP-COMPLIANCE.md established.

**Row-Level Security (RLS):** 22 `tenant_isolation` policies across the schema (verified by grep as of Phase 7; 19 through Phase 6 + 3 new for `drivers`/`delivery_jobs`/`delivery_job_status_history`). Every tenant-owned table has it; `users`, `refresh_tokens`, `password_resets`, `email_verifications` deliberately do not (documented reasons in §5). Enforced via `withTenant()` setting `SET LOCAL app.business_id` inside every service-layer transaction. Proven — not just claimed — by a dedicated isolation test suite in every phase (`*-isolation.test.ts`), each proving a seeded tenant A cannot read/write/see tenant B's rows even by exact primary key, and that INSERT with a hostile `business_id` is rejected by the RLS `WITH CHECK` clause. **Phase 7 added a second, deliberately separate authorization axis — "self scope" (can this caller act on this record because it's assigned to them) — kept entirely out of RLS on purpose**, since it depends on a join RLS's simple tenant predicate isn't suited to; folding it in would have blurred the "RLS defends the tenant boundary, application layer organizes access within one trusting business" split this project has held since Phase 3. See Decisions Log #28.

**JWT:** Access tokens 15-minute TTL, signed HS256 in development only. **Production RS256 signing is NOT YET IMPLEMENTED** — the config loader (`src/config/env.ts`) refuses to boot with `JWT_ALGORITHM=HS256` when `NODE_ENV=production`, which prevents an insecure deploy but does not itself provide the RS256 code path. This is the single most important piece of unfinished auth infrastructure before any production deploy — see §12/§13.

**Password hashing:** Argon2id, tunable parameters via env, verified against OWASP's current recommendation. Constant-time login path (dummy-hash verify) prevents user-enumeration-by-timing — tested.

**SQL injection protection:** Parameterized queries only, via Kysely's query builder or tagged-template `sql` — no raw string concatenation exists anywhere in the codebase (verified by grep in every phase's report). Every phase's `*-authz.test.ts` includes 4–6 SQL injection payloads run against search/filter inputs, asserting the query succeeds harmlessly and the target table is verified intact afterward.

**XSS protection:** API is JSON-only (`Content-Type: application/json` on every response) — there is no HTML-rendering surface in the backend yet (PDF/receipt rendering, which will need its own escaping review, is unbuilt). Every phase includes a test confirming a `<script>` payload in a bilingual name field is stored and returned as inert JSON, not executed.

**CSRF protection:** Refresh tokens live in an HttpOnly cookie (`SameSite=Lax`, `Secure` required in production via config). Access tokens live in the `Authorization` header, which is not automatically attached cross-origin by browsers, so the CSRF surface is narrow (limited to the refresh endpoint). A custom-header double-check on `/auth/refresh` was planned in `SECURITY.md` but is **not yet implemented** — flagged in §12.

**Audit logs:** Append-only `activity_logs` table, immutability enforced by a database trigger (`enforce_append_only()`, blocks both UPDATE and DELETE, verified by a dedicated negative test in Phase 1's `append-only-audit.test.ts`) — not just an application convention. The same trigger function is now reused by four ledger tables (`payments`, `order_status_history`, `inventory_movements` since Phase 5, and `delivery_job_status_history` since Phase 7), each with its own dedicated negative test rather than relying on inherited trust from Phase 1's proof against a different table. Every state-changing endpoint in every module writes an audit row inside the *same transaction* as the change (`auditInTx`), with before/after diffs containing only changed fields. Verified per-module in every phase's functional test suite.

**Rate limiting:** `@fastify/rate-limit` is installed and configured for auth endpoints (login attempt throttling backs the brute-force lockout tested in Phase 1). **No rate limiting exists on customers/orders/branches/inventory endpoints yet** — flagged as an open risk in every phase's report since Phase 2, not yet addressed.

**Backups:** **Not yet built.** No backup strategy, no restore drill, no disaster-recovery plan exists in this repo. This is entirely a Phase 8 (infrastructure hardening) concern per `BACKEND-SPEC.md`'s roadmap and has not been started.

---

## 11. Decisions Log

*Every architectural decision, in the order it was made, with the reason. Never edited after the fact — if a decision is later reversed, that reversal is recorded as a new entry, not a rewrite of the old one.*

1. **Shared-schema-with-RLS multi-tenancy**, over database-per-tenant or application-only filtering. *Reason:* near-database-per-tenant isolation guarantee at near-shared-schema operational cost; the database enforces the boundary even if application code has a bug. (`BACKEND-SPEC.md` Appendix A.1)

2. **Kysely over Prisma** as the query layer. *Reason:* Prisma's connection-pooling model actively fights RLS session variables (`SET LOCAL`); Kysely's transaction API makes `withTenant()` straightforward. (`BACKEND-SPEC.md` Appendix A)

3. **Fastify over Express**, Node/TypeScript over Django/Rails. *Reason:* 2× throughput, native JSON-schema validation, and — critically — a future frontend rewrite can share TypeScript types with the backend. (`BACKEND-SPEC.md` Appendix A)

4. **Argon2id over bcrypt** for password hashing. *Reason:* current OWASP recommendation, memory-hard (better GPU/ASIC resistance than bcrypt).

5. **JWT access + rotating opaque refresh tokens**, over long-lived JWTs or session-cookie-only auth. *Reason:* short-lived access tokens limit blast radius of a leaked token; refresh rotation with family-based reuse detection turns "a token leaked" into "detected on next use, whole session tree revoked" rather than a silent permanent compromise.

6. **`users` and `refresh_tokens` deliberately outside RLS.** *Reason:* a user identity is global (can belong to multiple businesses); a session belongs to a user, not a tenant. Applying RLS to either would be incorrect, not just unnecessary.

7. **Tenant isolation = RLS; branch-level scoping = application layer**, deliberately different mechanisms for what look like similar problems. *Reason:* RLS defends the catastrophic boundary (cross-tenant data leak, adversarial trust model); branch scoping organizes access within one trusting business, where a bug's worst case is "a manager saw another shop's numbers," not "a competitor read our customer database." Encoding branch scope as a second RLS policy would add real complexity (array-containment predicates, "empty means all" special-casing, owner/cross-branch-report bypasses) to defend a much lower-stakes boundary. (Originally proposed in the Orders architecture discussion, explicitly approved by the user before Phase 3, then reapplied unchanged in Phase 4 for branches.)

8. **Customers are business-scoped; orders are branch-aware, via a three-column branch triple (intake/processing/collection)** rather than a single `branch_id`. *Reason (user-approved after an explicit trade-off discussion before Phase 3):* laundries commonly run hub-and-spoke (several shops feeding one central plant); a single branch column forces choosing between recording where the money came in vs. where the work happened, and that choice is not reconstructable later from historical data. NULL-means-same-as-intake keeps single-branch businesses (the common case today) completely unaffected — one branch, two NULLs, zero added complexity surfaced. Read access uses OR-logic across all three columns; create access is narrower (intake branch only), because creating revenue against a branch you don't belong to is a different risk than merely being able to see or process an order that happens to touch your branch.

9. **Invoice numbering is business-scoped and gapless; order numbering is branch-scoped and resets daily** — explicitly different rules for two superficially similar sequences. *Reason (user-approved, same discussion as #8):* UAE FTA requires invoice numbers to be gapless per tax registrant (the business), not per branch; conflating the two would either break FTA compliance or make order numbers unnecessarily business-wide-contended. Invoice numbers are allocated only at `delivered` status, never at creation, so a cancelled order never burns one — verified by a dedicated test using an actual cancelled order interleaved between two delivered ones.

10. **Hand-rolled transactional counters (`INSERT ... ON CONFLICT DO UPDATE ... RETURNING`) instead of Postgres sequences** for both order and invoice numbering. *Reason:* `nextval()` is non-transactional — a rolled-back order creation would still have consumed a sequence value, which is a real compliance problem for gapless invoice numbers specifically, not just an aesthetic gap in order numbers.

11. **Customer lifetime statistics are business-wide, not per-branch.** *Reason (user-approved before Phase 3):* "We are building a multi-branch laundry business, not a franchise system. Franchise support can be considered in a future version." A branch manager seeing a customer's full history (even from other branches) is acceptable within one trusting business; it would not be acceptable across competing franchisees, which is explicitly out of scope for now.

12. **`customer_stats` is a database VIEW returning zero placeholders**, not stored aggregate columns updated by delta arithmetic. *Reason:* the original frontend prototype's most-cited fragility was exactly this pattern (stored `spend`/`outstanding` fields drifting out of sync on every mutation). A view computed fresh from `orders`/`payments` cannot drift — it's definitionally always correct once those tables exist. Chose to ship the *shape* of this fix in Phase 2 (before orders existed) specifically so the API contract never has to change when Phase 3+ wires the real computation.

13. **Branch management: CREATE requires all-branch scope; UPDATE/ENABLE-DISABLE/DELETE/RESTORE require the target branch in scope; READ is business-wide regardless of scope.** *Reason:* creating a new branch is a business-wide decision with no existing branch to scope the action to, so "manage your assigned branches" cannot apply to it — only owners/all-branch managers may create. Branch metadata (name, code, hours) is organizational information, judged not sensitive enough to warrant scope-restricting reads even for a single-branch manager. **This READ decision has not yet been formally re-confirmed by the user** — flagged as open in `PHASE-4-REPORT.md` §8 and carried into this document's §8.

14. **`manager_user_id` on a branch is descriptive, not authorizing.** *Reason:* avoiding an unrequested, silent coupling between two systems (branch metadata display vs. permission scoping via `membership.branch_ids`) that the user did not ask to be merged. **Not yet formally re-confirmed by the user** — flagged as open, same as #13.

15. **Append-only ledgers (`payments`, `order_status_history`, and planned `inventory_movements`) enforced by a database trigger**, not application-layer convention. *Reason:* "don't edit this table" as a code comment is a wish; a trigger that raises an exception on UPDATE/DELETE is a guarantee. Reused the same `enforce_append_only()` function (written once in Phase 0/1) across every ledger table since, rather than writing bespoke immutability logic per table.

16. **PROJECT_CONTEXT.md created as permanent cross-session memory** (this document), at explicit user request, to be read first and updated after every task so future conversations don't require re-reading old chat history. *Reason:* stated directly by the user — treat this file as the project's continuity mechanism.

17. **"Unpaid" for the customer-deletion guard means any non-deleted order with `total > paid_amount`, regardless of order status** — including cancelled/lost orders. *Reason:* a cancelled order that already collected a deposit still represents real money owed (or, symmetrically, a real refund the business owes); the order's own lifecycle status does not erase that. Soft-deleted orders are excluded from the check, because `orders.deleteOrder` already refuses to soft-delete any order with `paid_amount > 0` — so a soft-deleted order can only have collected nothing, and once deleted it is no longer part of the customer's live picture. No `?force=true` override was added — kept the fix minimal per explicit user instruction; a force-override is a separate, unmade feature decision, not part of closing this gap.

18. **Inventory (Phase 5) will use a simple single-branch scope check, not the Orders-style three-column OR predicate.** *Reason (user-confirmed):* inventory stock does not have Orders' intake/processing/collection three-role concept — a stock quantity is inherently at exactly one branch. This is structurally closer to the Branches module's `assertCanManageBranch` shape than to Orders' `branchReadPredicate`. A future stock-transfer-between-branches feature, if built, would be two ledger rows against two branch-scoped balances, not a three-column order-style record. **Extended during Phase 5's build:** unlike Branches (where reads are business-wide), inventory stock *reads* are also scope-restricted, not just writes — stock is exactly the per-branch-owned data the brief calls out, whereas branch metadata was judged organizational information. Catalog CRUD (`inventory_items`), by contrast, has no branch-scope check at all, since the catalog itself is business-wide. Three different scope shapes across three modules, each fitted to what the underlying data actually represents.

*(Correction made during the Phase 6 pass: entries #19–22 below had accidentally been written twice each, with slightly different wording, by whatever produced this document's Phase 5 update — a duplication bug, not two separate historical decisions. De-duplicated here, keeping one wording for each; nothing about their substance changed.)*

19. **Inventory stock levels are a computed database VIEW (`inventory_stock_levels`), never a stored column** — the exact same pattern Phase 2 already applied to `customer_stats` (Decision #12), reapplied here on purpose rather than reinvented. *Reason:* a stored quantity incrementally updated by every receive/waste/adjust/transfer is precisely the shape of bug the original frontend prototype was most criticized for (stored aggregates drifting from the ledger that's supposed to be their source of truth). Current stock is instead always exactly `SUM(quantity_delta)` for a given `(branch_id, item_id)` — it cannot disagree with its own history because it *is* its own history. A plain view, not materialised, matching `customer_stats`' "reassess only if it's actually slow" reasoning.

20. **A branch-to-branch stock transfer is two ledger rows (`transfer_out` at the source, `transfer_in` at the destination), correlated by a shared `transfer_group_id` UUID — not a self-referencing FK.** *Reason:* the two rows are peers, not a parent/child pair the way a refund payment refers back to the original payment it's refunding (`refunded_from_payment_id`). A shared correlation value fits a peer relationship; a self-reference would force an arbitrary choice of which leg is "primary."

21. **An inventory item cannot be deleted while it holds nonzero stock at any branch — but, deliberately unlike Branches' "any historical order blocks deletion" rule, an item's mere movement *history* does not block deletion.** *Reason:* a branch reference is a hard FK every order row needs to keep meaning forever, so Branches blocks on any history at all. An inventory movement snapshots nothing about the live catalog row that would break if the item disappeared — the operational hazard being guarded against is deleting an item you still physically have units of, not that it was ever moved. Blocking on any history (matching Branches' rule verbatim) would make almost every real catalog item permanently undeletable, which defeats the point of having a guard at all.

22. **Receiving stock, recording waste, and adjusting stock are three separate endpoints with three separate permissions (`inventory.receive`, `inventory.waste_record`, `inventory.adjust`), not one generic movement endpoint with a `type` field.** *Reason:* mirrors the precedent Orders already set with `payments`/`refund` — separate endpoints because the actions carry genuinely different permissions, not because one endpoint couldn't technically dispatch on a type parameter.

23. **Business Settings is a NEW table (`business_settings`), 1:1 with `businesses` via `UNIQUE(business_id)`, rather than adding ~15 columns directly to `businesses`.** *Reason:* `businesses` is the tenancy root — referenced by RLS's `current_business_id()` context and touched by the auth module at every signup/login. Six of the requested "Business information" fields (name, trade licence, tax registration, currency, language, timezone) already existed there since Phase 0 and were left exactly as they were; only the genuinely new fields (legal name, VAT/express rates, branding, contact info) got a new table. This matches how every other new capability in this schema has arrived — its own table — rather than bolting onto an existing one, and keeps `businesses` itself completely unchanged and lower-risk to touch.

24. **The Settings API presents one unified, flat resource spanning two physical tables; the service layer routes each field to the correct table, invisibly to the caller.** *Reason:* from the outside, "business settings" is one conceptual thing, matching the phase brief's explicit ask for "a single source of truth." Internally, `businesses` and `business_settings` stay genuinely separate tables with separate constraints (only `business_settings` has `updated_by_user_id`; only `businesses` lacks a soft-delete column at all). The PATCH schema is flat, not nested by section (business info / branding / contact) — chosen to match every other module's flat-PATCH convention (customers, branches, inventory) rather than introduce a one-off nested shape for just this endpoint, even though the GET response *does* read more naturally grouped into those three sections for the client.

25. **No hardcoded VAT/express literals survive anywhere — `orders/repository.ts`'s `findBusinessSettings()` was extended (not replaced) to INNER JOIN `business_settings` and return `vatEnabled`/`vatPct`/`expressPct` alongside the fields it already returned.** *Reason:* this function was already called at exactly the two right places in `orders/service.ts` (`createOrder`, `updateOrderLines`) to fetch business context for pricing — extending its return shape was a smaller, more surgical change than adding a second lookup call at each site. INNER JOIN (not LEFT + COALESCE) matches the "fail loudly, don't silently default" philosophy `business_settings/repository.ts`'s own `getCombined()` already established for this exact one-row-per-business invariant — consistency between the two modules mattered more than defense-in-depth redundancy for a state that three other layers (migration backfill, signup hook, UNIQUE constraint) already make effectively impossible to reach.

26. **`theme` is a strict two-value enum (`'light' | 'dark'`), not three (`'light' | 'dark' | 'auto'`).** *Reason:* the phase brief asked for exactly "Light/Dark theme." An initial draft included a third `'auto'` option — a reasonable, common real-world default, but broader than what was actually requested. Trimmed across all five touch points (DB CHECK, Kysely type, Zod enum, and their two respective TypeScript declarations) to match the literal spec rather than silently ship extra scope, consistent with this project's standing discipline of not expanding a request without saying so.

27. **`delivery_fee` got its own new migration (`0011`) extending `business_settings`, rather than an edit to migration `0010`, even though both were written the same day and `0010` had not yet been marked complete-and-approved when the gap was found.** *Reason:* migrations in this schema are never edited after being written, only added to — regardless of how "fresh" the prior one is (`0008` extended `branches` from `0002` the same way, long after that migration had shipped). Treating "written minutes ago, not yet approved" as an exception to that rule would have created a real one, and the rule exists precisely so a migration file is never a moving target. **A second, deliberate departure from the `0010` pattern within the same migration:** `delivery_fee`'s default (`15.00`) does *not* match the backend's old hardcoded literal (`10`) — unlike `vat_pct`/`express_pct`, which were chosen specifically to match the literals being deleted and therefore caused zero behavior change for existing businesses. The user's instruction was explicit that `15` — the frontend's value, not the backend's — must be the default; the migration's own comment says so plainly rather than letting the "no behavior change" framing from `0010` bleed into a case where that's no longer true. **A third decision, by omission:** no `delivery_fee` snapshot column was added to `orders`. Unlike VAT/express (percentages, needing a rate column alongside the computed amount so a receipt can show both), delivery is a flat fee — `orders.delivery_amount` (existing since Phase 3) already *is* the complete, immutable snapshot. Adding a redundant rate column would have duplicated it for every delivery order and meant nothing for every non-delivery one.

28. **Delivery introduces "self scope" — a caller can act on a record because it's assigned to them, independent of branch scope entirely — kept out of both RLS and the declarative `authorize()` middleware, living only in the service layer.** *Reason:* RLS's `business_id = current_business_id()` predicate isn't suited to a join against "does this user id match the assigned driver's user id"; folding it in would blur the RLS-defends-the-tenant-boundary / application-layer-organizes-access split held since Phase 3. `authorize()` is documented as strictly AND-only by design ("mixing AND/OR in code has been a source of RBAC bugs elsewhere and is deliberately not supported") and was never going to express "the driver themselves, OR someone with `delivery.dispatch`" as a static permission list. **This decision is the direct cause of a real bug, found and fixed during this phase's own pre-completion verification:** `POST /delivery/drivers/:id/status` was written with `authorize(["delivery.execute", "delivery.dispatch"], { mode: "any" })` — an option `authorize()` has no parameter for. Silently ignored at runtime (JavaScript ignores extra arguments to a function); would fail to type-check under `tsc`. Since no non-owner role holds both permissions, the route was callable only by the owner — broken for its two actual intended callers. Fixed by moving the OR logic to where it already correctly lived in `service.setDriverStatus` (`isSelf || auth.permissions.includes("delivery.dispatch")`) and loosening the route to a coarse `authorize(["delivery.read"])` gate. A dedicated regression test suite (`delivery-isolation.test.ts`) proves the fix — a manager, and the driver themself, both now succeed; an unrelated driver and a cashier are both still correctly refused.

29. **Cash-on-delivery completion calls `orders/service.ts`'s `recordPaymentInTx` directly, inside Delivery's own transaction — the first service-to-service call across a module boundary in this codebase.** *Reason:* explicit final instruction — "Reuse Orders.recordPayment(). Do not duplicate payment logic." Every prior cross-module interaction (Branches reading Orders for its historical-order delete-guard, Customers reading Orders for its unpaid-order delete-guard, Orders reading Business Settings for pricing) was a **read**; this is the first **write**. Implemented by splitting `recordPayment` into `recordPaymentInTx(trx, ...)` (the entire original logic, transaction-taking) and `recordPayment(...)` (a 4-line wrapper that opens `withTenant` and delegates) — the minimal mechanical change needed to make reuse safe, with the comment in the code stating plainly that this causes zero behavior change for `orders/routes.ts`'s existing, unchanged call site. A naive call to the public `recordPayment` from inside Delivery's transaction would have opened a second, nested transaction — wrong, since the job completion and the payment must succeed or fail together atomically.

30. **Every delivery job requires an existing order — final decision, no exceptions, including for `pickup`-type jobs.** *Reason:* stated explicitly by the user, reversing the design document's original recommendation that pickup jobs be order-independent (collecting laundry before any order exists). The simpler, uniform rule was chosen over the more elaborate one — a pickup job still references a real order (created by staff when the pickup is scheduled), keeping exactly one linkage rule for both job types rather than two.

31. **Both `failed` and `cancelled` require a reason, sharing one column (`fail_reason`), extended via CHECK constraint during implementation verification — not part of the original migration draft.** *Reason:* found during verification that `orders.cancel_reason` already covers both `cancelled` and `lost` with one column, and that `delivery_jobs`' own `fail_reason` column and its CHECK constraint only covered `failed`, leaving cancellation reason-less even though `delivery_job_status_history.reason` exists specifically to capture it. Fixed by extending the CHECK to `status NOT IN ('failed','cancelled')`, matching the existing precedent, rather than adding a second, separately-named column — same column, kept its original name rather than renamed, since renaming would have rippled through five already-written files for a same-day, pre-completion fix.

32. **Vehicle information is exactly three fields — `vehicle_type`, `plate_number`, `notes` — no richer vehicle model, despite the frontend prototype showing additional detail (a combined "Bike · AJM 4471" string plus a `photo` field).** *Reason:* explicit final instruction listing exactly these three fields. `vehicle_type` is a strict enum (`bike`/`car`/`van`) rather than the frontend's free-text combined string, matching this project's general preference for structured data (branch working hours, geo coordinates) over free text where the value is genuinely categorical.

---

## 12. Known Limitations

*Consolidated from every phase report's "remaining risks" section. Nothing here is a secret — every item was disclosed in the phase that surfaced it. Grouped by area, not by phase, so this reads as a current risk register rather than a history lesson.*

**Authentication / production readiness:**
- RS256 JWT signing is not implemented — only the HS256 dev path exists, with a config guard that *prevents* an insecure production deploy but does not itself provide the secure alternative.
- MFA schema exists (`users.mfa_secret`) but is unencrypted at rest and has no enrollment/verification endpoints.
- Password reset and email verification tokens are generated but the actual email-sending integration does not exist — tokens are logged to console in dev only. This blocks onboarding any real customer until a notifications module (unscheduled) exists.
- No custom-header CSRF double-check on `/auth/refresh` (planned in `SECURITY.md`, not implemented — the `SameSite=Lax` cookie flag provides partial protection today).
- A 5-second idempotency window for concurrent refresh-token races was planned, not built — a mobile client racing two refresh calls could trigger a false-positive "token reuse" family revocation.

**Authorization / product decisions awaiting confirmation:**
- Whether `manager_user_id` should auto-grant branch access (currently: no, purely descriptive).
- Whether branch metadata reads should be scope-restricted like orders/inventory (currently: no, business-wide). Inventory's Phase 5 stock-read model (scope-restricted) is now a concrete, working example of what the alternative would look like for branches, if that's the direction chosen.

**Data model gaps (deliberately deferred, not accidental):**
- `customer_stats` view returns zero for every field — real computation against `orders`/`payments` was deferred by design so the API contract wouldn't need to change later, but it means anything reading `/customers/:id` today sees misleading zeroes if not aware of this.
- `hasDebt` customer filter is accepted by the API schema but is a documented no-op until `customer_stats` is real.
- ~~Customer deletion does not check for unpaid orders~~ — **fixed** (see Progress Log, "Customer-deletion unpaid-orders guard" entry). `deleteCustomer` now refuses with `409 customer-has-unpaid-orders` when the customer has any non-deleted order with `total > paid_amount`, regardless of order status. No force-override exists — that remains a separate, unmade feature decision.
- `order_photos` table exists with zero implementing code (no repository functions, no routes) — this is presigned-upload infrastructure that hasn't landed for any module yet (customers, orders, or branches all have the same gap for photo/logo uploads).
- ~~Inventory consumption on order completion is a named-but-unimplemented hook (`checkTransition().triggersConsumption`) — Phase 5 territory.~~ **Still unimplemented as of Phase 5's close** — Phase 5 built the inventory module itself but deliberately did not wire this connection (not one of the four stated Phase 5 requirements; needs its own scoping pass, including a recipe concept that doesn't exist anywhere yet). Now a candidate for whichever phase comes next — see §9.
- ~~Express surcharge and VAT rate are hardcoded per-business in `orders/service.ts`, not configurable per-branch or via a settings table.~~ **Fixed — Phase 6 (VAT/express) and its same-day delivery-fee follow-up (delivery fee). All three now come from `business_settings`; none are hardcoded.** Branch-level overrides remain out of scope, unchanged from how this was always business-wide even as a literal (Decision #27).
- `updateOrderMeta` (notes/due date) has no status-based edit lock, unlike `updateOrderLines` — an open, undecided inconsistency.
- Name-sort pagination on customers has weaker cursor guarantees than the default created-at sort.
- No "branches I manage" filtered listing endpoint.
- No timezone marker on branch working hours (implicit business-timezone assumption).
- Inventory has no reorder threshold / low-stock alerting (not part of Phase 5's four stated requirements).
- Inventory has no formal stocktake/audit workflow — `inventory.audit` remains reserved but unimplemented; the single-item `adjust` endpoint covers one correction at a time, not a multi-item count-and-reconcile flow.
- Order-triggered automatic stock consumption remains unwired — Phase 3's `checkTransition()` still returns `triggersConsumption: true` on the move to `ready` with nothing listening to it. The inventory module that would consume it now exists (Phase 5), but the connection itself — and the recipe concept it depends on (how much of an item one order consumes) — was not built.
- No standard-cost comparison or anomaly flagging on inventory `unit_cost` — a receive at a wildly different cost than usual currently passes through unflagged.
- No presigned-upload path for inventory item photos (no `photo_url`-equivalent column exists on `inventory_items` at all — unlike customers/branches, where the column exists but the upload flow doesn't; nothing in the Phase 5 brief asked for item images). *(This line previously appeared twice, with slightly different wording — the same accidental-duplication pattern already caught once in the Decisions Log; de-duplicated here during the Phase 6 delivery-fee follow-up pass, noted transparently rather than silently.)*
- No presigned-upload path for delivery proof either — `delivery_jobs.proof_photo_url`/`proof_signature_url` are the fifth and sixth URL-reference-only columns in this schema (after customers, branches ×2, business_settings ×2) with no actual upload flow behind them.
- OTP-based delivery verification does not exist — it was present in the frontend prototype and in an early draft of the Phase 7 design document, but never made it into the user's finalized decision list and was correctly dropped rather than added as unrequested scope. Proof of delivery today is photo + signature + GPS only.
- No order-triggered automatic delivery-job creation — an order reaching `ready`/`out_for_delivery` does not auto-spawn a job. Explicitly out of scope for Phase 7 (`PHASE-7-DESIGN.md` §3), now a concretely buildable next step since the Delivery module exists (see §9).
- No SMS or push notification integration for delivery job status — matches the frontend's own dispatcher-facing design (not a gap relative to what was being replicated), but worth naming as a real product limitation if customer-facing delivery tracking is ever wanted.
- No reorder threshold / low-stock alerting for inventory — not part of Phase 5's four stated requirements; cheap to add later (one table, a computed comparison) but needs a decision on whether the threshold is per-item (business-wide) or per-branch first.
- No formal multi-item stocktake/audit workflow — the `inventory.audit` permission has been reserved since Phase 0 and remains unused; Phase 5's `adjust` endpoint only handles one item's correction at a time.

- No standard-cost comparison or anomaly flagging on `inventory_movements.unit_cost` — a receive at a wildly different cost than usual currently passes silently.

**Infrastructure (entirely unstarted, not partial):**
- No Dockerfile, no CI/CD pipeline, no Nginx config, no production deployment of any kind.
- No rate limiting on customers/orders/branches/inventory/settings/delivery endpoints (only auth endpoints are covered).
- No backup strategy or restore drill.
- No dependency vulnerability scanning in CI (because there is no CI).
- `OWASP-COMPLIANCE.md`'s full risk table still reflects Phase 1's state and has not been comprehensively re-run — but as of Phase 7 it now carries targeted evidence addenda (A01, A04, A09) for the specific controls that changed in Phases 6 and 7, added per explicit instruction to update it "only where evidence changes" rather than attempt the full re-audit in the same pass. The comprehensive re-run remains separately tracked below.

**Frontend integration:**
- The original React/JSX frontend prototype is entirely unconnected to this backend. It still runs against `window.storage`. Wiring it to the real API (replacing every `repo.*` call in the frontend with a `fetch()` against these endpoints) is unstarted, scoped work.

---

## 13. TODO

*Live checklist. Check items off in place (change `[ ]` to `[x]`) rather than deleting them, so completed work stays visible in this document's history.*

### Immediate / before Phase 5 started (historical — Phase 5 is now complete)
- [ ] Get explicit user confirmation on the two open Phase 4 product decisions (`manager_user_id` scope-granting; branch-read business-wide-vs-scoped). **Still outstanding — see §8.**
- [x] Decide the inventory branch-scope model explicitly (see §9) before writing the Phase 5 migration. **Decided: simple single-branch scope — Decisions Log #18.**
- [x] Re-examine whether "customer deletion should check unpaid orders" (deferred in Phase 2) is now unblocked by Phase 3's orders existing. **Fixed — see Progress Log.**

### Phase 5 — Inventory (complete)
- [x] Design `inventory_items` (business-scoped catalog) + branch-scoped movement ledger (not a separate "stock table" — stock is computed, see Decision #19).
- [x] Design `inventory_movements` as an append-only ledger reusing `enforce_append_only()`.
- [x] Add barcode/SKU columns, unique per business, indexed for fast scan-to-lookup.
- [x] Build `GET /inventory/items/by-code/:code` as the scan-resolution endpoint.
- [x] Full regression suite: RLS isolation, branch-scope enforcement, injection resistance, validation, functional (stock in/out, movement immutability). 72 new test blocks.
- [x] Phase 5 completion report.

### Next-phase candidates (none chosen yet — see §9)
- [ ] Scope and build order-triggered automatic stock consumption (needs a recipe concept first — how much of an item one order consumes).
- [ ] Scope and build a formal multi-item stocktake/audit workflow (`inventory.audit` permission already reserved).
- [ ] Scope and build reorder thresholds / low-stock alerting (decide per-item vs. per-branch threshold first).
- [ ] Scope and build order-triggered automatic delivery-job creation (new candidate as of Phase 7 — see §9; now concretely buildable since the Delivery module exists).

### Phase 7 — Delivery & Driver Management (complete)
- [x] Fresh audit determining Phase 7's scope (`PRE-PHASE-7-AUDIT` folded into `PHASE-7-DESIGN.md` §0–§1) — found the `driver` role dead since Phase 0, chose Delivery over the three §9 candidates.
- [x] Design document with 7 open questions, all resolved by explicit user decision before code was written.
- [x] Migration `0012` — `drivers`, `delivery_jobs`, `delivery_job_status_history`.
- [x] Cross-module `recordPaymentInTx` split in `orders/service.ts` for COD reuse — zero behavior change for the existing `recordPayment` caller.
- [x] Full regression suite: RLS isolation, branch-scope (Inventory model) + the new self-scope axis, injection resistance, validation, functional. 71 new test blocks.
- [x] Two real bugs found and fixed during pre-completion verification (broken OR-permission gate; missing schema export) — see Decisions Log #28.
- [x] `OWASP-COMPLIANCE.md` evidence addenda for A01/A04/A09 (targeted, not a full re-audit).
- [x] Phase 7 completion report.

### Security backlog (not tied to a specific future phase, but overdue)
- [ ] Implement RS256 JWT signing for production.
- [ ] Encrypt `users.mfa_secret` at rest; build MFA enrollment/verification endpoints — or formally decide to defer MFA further and document why.
- [ ] Add rate limiting to customers/orders/branches/inventory/settings/delivery endpoints (currently only auth is covered).
- [ ] Add the custom-header CSRF check on `/auth/refresh`.
- [ ] Re-run `OWASP-COMPLIANCE.md`'s full risk table against the current (Phase 7) test suite — it is comprehensively stale as of Phase 1, though it now carries targeted evidence addenda for the specific controls Phases 6–7 touched (see §10).

### Infrastructure backlog (Phase 8 per BACKEND-SPEC.md, entirely unstarted)
- [ ] Dockerfile + container build.
- [ ] CI/CD pipeline with dependency vulnerability scanning.
- [ ] Nginx / reverse proxy configuration.
- [ ] Backup strategy + first restore drill.
- [ ] Production secrets management.

### Frontend integration (unstarted, unscoped)
- [ ] Decide integration approach (incremental module-by-module vs. big-bang) before starting.
- [ ] Replace the frontend's `window.storage`-backed `repo` objects with real `fetch()` calls against this API, module by module.

### Presigned uploads (blocks photo/logo/proof features across 4+ modules)
- [ ] Design and build the presigned-URL upload flow (spec §9) — currently `photo_url`/`logo_url`/`favicon_url`/`proof_photo_url`/`proof_signature_url` are plain string columns with no upload path anywhere, across customers, branches, business_settings, and now delivery.

---

## 14. Progress Log

*Dated summary appended after every completed task or phase. Newest entries at the bottom. Never edit an old entry — append a correction as a new dated entry if something needs revisiting.*

**Phase 0 — Backend Foundation: completed and approved.**
Foundation layer built: Fastify/TypeScript skeleton, Postgres+Redis connectivity, RLS groundwork (tenancy tables + policies), Argon2id password hashing, HS256-dev JWT signing with a production RS256 guard, structured error handling, health checks, migration runner. 11 tests. No business modules — deliberately scoped that way.

**Security posture documents written: `SECURITY.md` and `OWASP-COMPLIANCE.md`.**
Established the project's permanent evidence discipline: a security control is only ✅ Verified when it has both code and a passing regression test. Applied retroactively to Phase 0's 11 tests, and forward to every phase since.

**Phase 1 — Authentication and Identity: completed and approved.**
Full auth lifecycle shipped: signup, login, refresh rotation with family-based reuse detection, logout, password reset, email verification, session listing/revocation, team invites. 46 new tests (11 → 57 total). 17 OWASP controls moved from planned/partial to ✅ Verified in this phase alone.

**Phase 2 — CRM Backend (Customers Module): completed and approved.**
Full customer CRUD with bilingual full-text search, status lifecycle, notes, soft delete/restore, and — critically — customer statistics implemented as a zero-placeholder database VIEW rather than the frontend's original fragile stored-aggregate pattern. 56 new tests (57 → ~113 total).

**Orders branch-architecture decision discussion (between Phase 2 and Phase 3, no code written).**
User asked for an explicit trade-off analysis: should orders be business-scoped or branch-scoped? Recommended and the user approved: orders branch-aware via a three-column branch triple (intake/processing/collection, NULL-means-same-as-intake), tenant isolation via RLS, branch authorization in the application layer with OR-logic reads and narrower create-time scope, business-scoped gapless invoice numbering vs. branch-scoped daily order numbering, and customer lifetime statistics staying business-wide (not per-branch, since "we are building a multi-branch laundry business, not a franchise system").

**Phase 3 — Orders Module (Branch-Aware Architecture): completed and approved.**
Built exactly the architecture approved in the prior discussion. Order intake, server-side pricing engine, forward-only status state machine, payment/refund ledger with laundering protection, dual numbering schemes. 66 new tests (~113 → ~179 total). Flagged the missing Branches CRUD endpoint as the top risk for the next phase.

**Phase 4 — Branches Management: completed and approved.**
Resolved Phase 3's top-flagged risk. Full branch CRUD, enable/disable, soft-delete-blocked-by-historical-orders (tested for the non-obvious processing-branch-only case), restore, contact/geo/working-hours fields, descriptive (non-authorizing) manager assignment. 62 new tests (~179 → ~241 total). Two product decisions flagged for explicit confirmation rather than silently assumed.

**PROJECT_CONTEXT.md created.**
This document. Built by fresh-inspecting the actual repository (migration files, route files, permission catalogue, RLS/trigger counts via grep) rather than reconstructing from memory — one real discrepancy was caught in the process (a `DELETE /me/sessions/:id` endpoint was initially undercounted by a naive grep because Fastify's generic-typed route syntax doesn't match a simple regex; corrected before this document was written). Established as the project's permanent cross-session memory per explicit user instruction: read first, update after every task, never delete history, append only.

**Phase 5 requirements stated (no code written yet).**
User specified four inventory requirements: barcode + QR code support per item, mobile-camera scanning (no dedicated hardware), shared catalog with per-branch stock quantities, and fully immutable/traceable stock movement logs. Recorded verbatim in §4 and §9. Architectural analysis (catalog/stock split mirroring the services/service_variants precedent; movement log reusing the existing `enforce_append_only()` trigger; barcode uniqueness scoped per business) written down for the next session, but no schema, code, or design decisions have actually been made yet — Phase 5 has not started.

**Customer-deletion unpaid-orders guard: fixed (small standalone task, not a phase).**
Per user instruction, resolved the stale Known Limitations item before starting Phase 5 rather than folding it in or deferring it further, and kept the change minimal — no unrelated changes bundled in. Added `repo.unpaidOrderSummary()` to `customers/repository.ts` (queries `orders` directly, the same established cross-module read-only pattern `branches/repository.ts`'s `historicalOrderCount` already uses) and wired it into `deleteCustomer` in `customers/service.ts`. "Unpaid" is defined as any non-deleted order for the customer with `total > paid_amount`, regardless of status — a cancelled order that took a deposit still counts. New error code `customer-has-unpaid-orders` (409), with both the count and total outstanding amount in the error details. No `force=true` override was added (that remains a separate, unmade feature decision — explicitly out of scope for this fix per the user's "do not introduce unrelated changes" instruction).

One implementation correction made during the fix, worth recording since it reflects a real codebase convention: the first draft used `fn.sum<string>(sql\`...\`)` to aggregate a computed expression (`total - paid_amount`); checked the rest of the codebase first and found no precedent for `fn.sum()` on anything but a plain column reference (`orders/repository.ts`'s `refundedTotalFor` is the existing example, summing a bare `"amount"` column). Switched to a raw `sql<string | null>\`sum(orders.total - orders.paid_amount)\`` tagged template instead, matching how every other non-trivial predicate in this codebase is already built, rather than introducing a new pattern.

**New test file:** `test/integration/customers-unpaid-orders.test.ts` — 7 test blocks: no-orders customer deletable; unpaid order blocks deletion with count+total in the error; fully-paid order does not block; a *cancelled* order with an unrefunded deposit still blocks (the case that specifically justifies "regardless of status"); a customer whose only order was itself soft-deleted (which can only happen when that order's `paid_amount` was already zero) is deletable; multiple unpaid orders are correctly counted and summed; a partially-paid order still blocks. *(Correction, made during the Phase 5 pass: this entry originally said "6 test blocks" and "241 → 247" — both were narration-time approximations, not fresh-grep figures. A fresh count during Phase 5 found 7 blocks in this file and a verified pre-Phase-5 total of 246, not 247. The 1-block drift was in this entry's prose, not in any code. See the Phase 5 entry below for the reconciled, fresh-grep-verified running total.)*

`PROJECT_CONTEXT.md` updated in the same pass: §4 gained the confirmed business rule, §8 and §9 updated to reflect the fix and the confirmed inventory branch-scope model, §11 gained Decisions Log entries #17 (unpaid-order definition) and #18 (inventory branch-scope model, user-confirmed), §12's stale item marked fixed with a forward reference (its original Phase-2/Phase-3 historical entries were left untouched, per this file's own "never rewrite history" rule), §13's TODO items checked off.

**Ready to start Phase 5 (Inventory).** Both pre-conditions the user set are now satisfied: the stale gap is closed, and the branch-scope model is confirmed. Phase 5 has not been started as of this entry — the next work is the migration design described in §9, now unblocked.

**Phase 5 — Inventory: completed and approved.**
Built exactly to the four-requirement brief recorded in §4/§9 after this session's prior turn, using the pre-confirmed single-branch scope model (Decisions Log #18). Two tables plus a computed view: `inventory_items` (business-scoped shared catalog, bilingual, barcode/SKU unique per business, full-text search reusing `normalize_arabic()`), `inventory_movements` (append-only ledger reusing the exact Phase 0/1 `enforce_append_only()` trigger — no new immutability logic written), `inventory_stock_levels` (a plain computed view, deliberately never a stored column — directly reapplying the `customer_stats` lesson from Decision #12 rather than repeating the mistake it fixed). 16 endpoints, 72 new test blocks across 3 files (**318 total test blocks, verified by fresh grep**, 20 → 23 files).

The property most worth remembering from this phase: **branch scope for inventory stock is read-AND-write restricted**, deliberately unlike Branches' business-wide-readable metadata — tested explicitly from both angles specifically because getting this backwards (copying Branches' read model by habit) would have been a real, easy-to-miss regression. Also tested explicitly in the other direction: catalog CRUD has *no* branch check at all, since the catalog itself is business-wide. Two different rules, both deliberate, both proven by dedicated tests rather than asserted.

One precedent-consistency correction made mid-build: an initial `db-schema.ts` draft typed the ledger's numeric columns as update-forbidden at the TypeScript level (`ColumnType<..., never>`), which would have been *stricter* than the existing `PaymentsTable.amount` convention (which permits the type but relies entirely on the runtime trigger). Checked precedent before finishing, matched it instead of introducing an unrequested stricter pattern — the runtime guarantee is identical either way.

Three follow-on directions were surfaced but deliberately left unscoped and undecided, since none was part of the four stated Phase 5 requirements: wiring Orders' already-flagged-but-unwired `triggersConsumption` hook to actually deduct stock (blocked on a recipe concept that doesn't exist yet); a formal multi-item stocktake workflow (`inventory.audit` permission has sat reserved-but-unused since Phase 0); reorder-threshold/low-stock alerting. `PROJECT_CONTEXT.md` §9 now names all three as candidates rather than picking one — that choice is deferred to whoever starts the next phase.

This entry completes a full pass over every section of this document — §1 through §14 all now reflect Phase 5's actual, verified state, not just the sections most obviously affected. Nothing was deleted; the stale/superseded lines from before Phase 5 (the original four-requirement brief in §9, the "Phase 5 territory" note on order-consumption in §12, the TODO checkboxes) were struck through or marked with forward references, following this file's own no-rewrite rule.

**Phase 6 — Business Settings & Branding: completed and approved.**
Preceded by an explicitly-requested, code-verified audit (`PRE-PHASE-6-AUDIT.md`) rather than a design session — the audit's own findings (four duplicated hardcoded VAT/express literals already calling a `findBusinessSettings()` function that just didn't fetch the right columns yet; four independent frontend `DEFAULT_SETTINGS` objects confirming the same numbers) became the phase's design brief. One new table, `business_settings`, 1:1 with `businesses` via `UNIQUE(business_id)` — the tenancy root itself left completely schema-untouched, matching how every prior extension in this schema has worked. A singleton `GET`/`PATCH /settings/business` presents fields from two physical tables as one flat object; the service layer routes each field to the table it actually lives on, invisibly to the caller. 45 new test blocks across 3 new files (318 → 363, 23 → 26 files). No new permission strings — reused `settings.read`/`settings.business.edit`, both reserved since Phase 0.

*(This entry was written retroactively, during the delivery-fee follow-up pass below — every other section of this document already reflected Phase 6's completion, but the Progress Log entry itself had been skipped. Caught while reviewing the file end-to-end for the follow-up; recorded now, out of strict chronological order, rather than left permanently missing.)*

**Phase 6 follow-up — delivery fee configurability (Option A): completed and approved, same day.**
The pre-Phase-6 audit had found and flagged a second hardcoded pricing constant — `deliveryFee: input.delivery ? 10 : 0` — explicitly out of scope for the original phase because the requested field list named "VAT or express percentages" specifically, not delivery. Given the choice (close it now vs. defer it), the user chose Option A. New migration `0011` (extending `business_settings`, not editing `0010` — migrations in this schema are never edited after being written) added `delivery_fee numeric(10,2) NOT NULL DEFAULT 15.00`, wired through the exact same path `vat_pct`/`express_pct` already used: `findBusinessSettings()` extended, both `orders/service.ts` call sites now read `business.deliveryFee`. Confirmed by a fresh grep across `src/` — zero hardcoded delivery literals remain anywhere in the backend.

One default was chosen *deliberately not* to match old backend behavior: `15.00` matches the frontend prototype's default, not the backend's stale `10` — a real, intentional behavior change for pre-existing businesses, called out explicitly in the migration's own comment rather than glossed over the way `0010`'s "no behavior change" framing correctly described *that* migration's defaults but would have been misleading here. No new snapshot column was added to `orders` — delivery is a flat fee, not a percentage, and `orders.delivery_amount` (existing since Phase 3) already serves as the complete immutable snapshot VAT/express need a dedicated rate column to achieve.

11 new test blocks across the 3 *existing* settings test files (no new files) — 363 → **374** total. Coverage matches every scenario the task asked for by name: changing the fee affects only new orders (tested), existing orders keep their snapshot (tested against `delivery_amount`, the closest analog to the `vat_pct` snapshot-immutability test), tenant isolation is unaffected (tested independently rather than assumed to inherit whole-row coverage). `PHASE-6-REPORT.md` gained a new §9 documenting this work in full, with its §8's now-resolved item struck through and forward-referenced rather than deleted.

Two small, adjacent documentation-integrity issues were found and fixed in the same pass, both pre-dating this task: §12's inventory-item-photos limitation had been accidentally written twice with slightly different wording (the same "written twice" bug already caught once in the Decisions Log, apparently missed there); and §12 still listed "VAT and express rate are hardcoded" as a live known limitation, which Phase 6 had already resolved days before but never marked as fixed. Both corrected here with forward references, following this file's own no-rewrite-history rule. A handful of *other* pre-existing duplicate lines in §12 (reorder thresholds, stocktake workflow, order-consumption — all Phase 5 topics) were noticed but deliberately left alone, since fixing them isn't part of this task and the user's instruction was explicit about not introducing unrelated changes.

**Phase 7 — Delivery & Driver Management: completed and approved.**
Preceded by an explicit, code-verified audit (findings folded into `PHASE-7-DESIGN.md` §0–§1 rather than a separate document) that recommended Delivery over the three candidates §9 had carried since Phase 5 — the deciding evidence being an entire permission-catalogue domain (`delivery.*`, 6 permissions, assigned across 4 of 5 seeded roles since Phase 0) with zero implementing endpoints anywhere, verified by grep. A full design document with 7 open architectural questions followed, approved in full; every question was then resolved by explicit, final, non-negotiable user decision before any code was written — every driver has a real user account, every job requires an order, branch scope follows the Inventory model, drivers use exactly three vehicle fields, no job numbering, GPS optional, and — the single most architecturally consequential call — cash-on-delivery reuses Orders' own `recordPayment` logic directly rather than duplicating it.

On inspecting the repository to begin implementation, the module was already substantially built (migration `0012`, all four module files, `db-schema.ts` types, the cross-module `recordPaymentInTx` split already correctly done in `orders/service.ts`) — the same pattern every phase since Inventory has encountered. Rather than trust or blindly redo it, verified it file-by-file, function-by-function against every one of the seven finalized decisions. **Found and fixed two real bugs and one gap, all before any test existed to catch them by accident:**

1. `POST /delivery/drivers/:id/status` was gated by `authorize(["delivery.execute", "delivery.dispatch"], { mode: "any" })` — a second argument `authorize()` has no parameter for (confirmed by reading its actual one-parameter signature and its own docstring, which explicitly documents strict AND-only semantics by design). Silently ignored at runtime; would fail to type-check. Since no non-owner role holds both permissions, the route was callable only by the owner — broken for its two actual intended callers (a driver setting their own status; a manager overriding it). Fixed by confirming the real OR logic already lived correctly in the service layer and loosening the route to a coarse permission gate — a one-line fix once correctly diagnosed.
2. `branchIdParamSchema` was imported in `routes.ts` but never defined in `schemas.ts` — would have crashed the module at load time, not just failed one request. Added it, matching the exact convention already used in Branches/Inventory.
3. `cancelJob` didn't capture a reason, unlike Orders' `cancel_reason` precedent, even though `delivery_job_status_history.reason` exists specifically for this. Extended the CHECK constraint, schema, service, and route to require one — a same-day edit to migration `0012` itself (not a new migration), consistent with how Phase 6's own mid-build fixes were handled before that phase was ever presented as complete.

Wired `api.ts` registration and `harness.ts` truncation entries (both previously missing). Wrote the full three-file regression suite from scratch — 71 new test blocks (20 isolation, 19 authz, 32 functional) — including a dedicated regression describe block that directly proves bug #1 is fixed: a manager and the driver themself both now succeed at the previously-broken endpoint, while an unrelated driver and a cashier are both still correctly refused. `OWASP-COMPLIANCE.md` received targeted evidence addenda to A01, A04, and A09 — the specific controls that changed — rather than a full re-audit, per explicit instruction to update it only where evidence changes; that comprehensive re-audit remains separately tracked in §13.

Project totals, all freshly verified rather than carried by arithmetic: 12 migrations, 9 modules, 29 test files, **445 test blocks**, 86 endpoints, 22 RLS policies, 10 append-only trigger attachments, 52 permission strings (unchanged — Delivery is the first domain to go from fully-reserved to fully-used in one phase, with zero new permission strings added).
