# Trend Laundry — Backend

Phase 0 foundation. No business modules yet — just tenancy, auth primitives, RBAC catalogue, migrations, and health checks.

## What's in this repo (Phase 0)

- **Fastify + TypeScript** API skeleton with strict typechecking.
- **PostgreSQL 15** schema for tenancy (`businesses`, `users`, `roles`, `memberships`, `branches`) with Row-Level Security enabled on every tenant-owned table.
- **argon2id** password hashing with tunable parameters.
- **JWT access token** signer/verifier (HS256 for dev; RS256 lands with Phase 1).
- **Refresh token** table with hashed storage and family-id rotation support.
- **Activity log** table with append-only trigger enforcement.
- **Migration runner** — timestamped, forward-only, transactional per file.
- **Health probes** — `/health/live` and `/health/ready`.
- **Structured logger** with redaction of secrets.
- **Vitest** with a small smoke suite covering the primitives above.

Not yet implemented: any customer, order, inventory, delivery, reports, or expense routes. Those are Phase 2 onward per `BACKEND-SPEC.md` §13.

## Running locally

You need Docker (for Postgres + Redis) and Node.js 20+.

```bash
# 1. Copy config, install deps
cp .env.example .env
pnpm install    # or: npm install / yarn install

# 2. Start Postgres + Redis
docker compose up -d

# 3. Apply migrations
pnpm migrate

# 4. Run the API
pnpm dev

# In another terminal, verify:
curl http://localhost:3000/health/live
curl http://localhost:3000/health/ready
```

Expected responses:

```json
// GET /health/live
{ "status": "ok", "uptime_s": 1 }

// GET /health/ready
{ "status": "ok", "db": true }
```

## Running the tests

```bash
pnpm test         # once
pnpm test:watch   # rerun on change
```

The Phase 0 suite is unit-level and does not require a running database. Integration tests that require Postgres arrive in Phase 1.

## Migration commands

```bash
pnpm migrate           # apply all pending
pnpm migrate:status    # show applied vs pending
pnpm migrate:down      # reverse the last migration (only if a .down.sql exists)
```

Migration files are timestamped and never edited after commit. Corrections are new migrations.

## Project layout

Full folder structure is in `BACKEND-SPEC.md` Appendix D. Phase 0 keeps only what's needed:

```
src/
├── config/         env + logger
├── lib/            db, jwt, passwords, errors, migrate
├── middleware/     request-id, error-handler
├── modules/
│   └── health/     /health/live and /health/ready
├── shared/         cross-module types + permission catalogue
├── api.ts          Fastify app factory
└── main.ts         entry point (api or worker via env.ROLE)

db/
└── migrations/     timestamped .sql files

test/
├── setup.ts        vitest globals
└── integration/    smoke tests
```

## Key decisions from Phase 0

1. **RLS is the tenant boundary.** Every migration adds `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` to tenant-owned tables, with a policy that reads `current_setting('app.business_id')`. The `withTenant()` helper in `src/lib/db.ts` sets that variable inside a transaction — no request touches tenant data without it.

2. **`users` is NOT tenant-scoped.** A user is a global identity. Access happens through `memberships`, which is tenant-scoped. This lets a single email log into multiple businesses without weird workarounds.

3. **Passwords use argon2id.** Parameters live in env so ops can retune without a code change if hardware capacity changes.

4. **Login timing is constant.** The verify path runs against a dummy hash when the user doesn't exist, matching the wall-clock time of a real verify. Prevents user-existence enumeration.

5. **HS256 in dev, RS256 in prod.** Enforced by config: `env.ts` refuses to start with `NODE_ENV=production` + `JWT_ALGORITHM=HS256`. Belt and braces.

6. **Migration runner is deliberately minimal.** Raw SQL, timestamped filenames, one transaction per file, applied table tracked in Postgres itself. No ORM-owned migration format that fights us later.

7. **Activity log is append-only in the database.** A trigger raises an exception on UPDATE or DELETE. Convention documented in a comment is not enough — enforcement lives in Postgres.

8. **Error responses are consistent.** Every failure returns `{ code, message, details? }`. No stack traces, no SQL, no provider messages leak to clients — those go to logs correlated by `X-Request-ID`.

9. **Config validation fails fast.** `src/config/env.ts` parses every env variable through Zod at boot. A bad config exits before opening a listen socket, so you never discover a missing secret at request time.

10. **Health separates liveness from readiness.** A slow database should not restart the pod; it should stop new traffic. `/health/live` = "the process is up". `/health/ready` = "the process + its deps are up".

## What's next (Phase 1)

Per `BACKEND-SPEC.md` §13 Phase 1:

- Full `/auth/*` implementation (login, refresh with rotation, MFA, password reset).
- `/team/*`, `/roles/*`, `/permissions` endpoints.
- Seed roles auto-created on business signup.
- Session listing and revocation.
- Audit-log writer middleware.
- Integration tests that spin up a real Postgres, seed two businesses, and prove RLS actually isolates them.
