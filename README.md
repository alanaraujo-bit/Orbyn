# Orbyn — developer documentation

Local-first Instagram prospecting system. Modular monolith: a Next.js operator
panel and a durable SQLite-backed worker in the same repository, started by a
single command.

The operator manual is in Portuguese: [`SETUP.md`](./SETUP.md). This file is for
whoever works on the code.

---

## Quick start

```bash
pnpm install
cp .env.example .env
pnpm db:migrate
pnpm dev          # panel on 127.0.0.1:4310 + worker, one Ctrl+C stops both
```

Verification gate (must be green before anything ships):

```bash
pnpm verify       # lint + typecheck + tests + production build
```

---

## Layout

```
config/business.json            operator-owned business record (git-ignored)
src/app                         Next.js App Router panel (pt-BR UI)
src/features/leads              discovery, scoring, lifecycle, suppression
src/features/conversations      threads, channel ownership, policy, engine
src/features/campaigns          pacing guardrails, first contact
src/features/experiments        variants, analysis, optimizer, strategy store
src/features/analytics          panel metrics
src/features/privacy            retention and anonymisation
src/features/system             capabilities, pauses, config integrity
src/integrations/instagram      official Graph client + webhook
src/integrations/browser        Playwright over CDP, drivers, safety detection
src/integrations/openai         model client, prompts, usage and budget
src/db                          schema, SQL migrations, backup/restore, CLIs
src/worker                      durable queue, handlers, runtime
src/lib                         shared infrastructure
tests                           unit, integration and end-to-end suites
```

Server Components by default; Client Components only where there is real
interaction (`nav`, `action-button`, `global-pause`, `import-leads`,
`stage-selector`). Mutations go through Server Actions in
`src/app/_actions/operations.ts`; the webhook and health endpoints are Route
Handlers.

---

## Core invariants

These are the properties the whole design exists to protect. Each one has a test.

**1. The business record is operator-owned.** Nothing in `src/` opens
`config/business.json` for writing, and `tests/config/immutability.test.ts` scans
the source tree to keep it that way. Learned intelligence lives in
`strategy_state`, never mixed with official facts. The schema is `.strict()`, so
extra keys are rejected outright.

**2. Exactly one channel owns a thread.** `conversations.channel_owner` is the
lock. The browser owns the first contact; once the lead replies, ownership moves
to the API permanently — the channel state machine in
`src/features/leads/states.ts` has no edge back to `browser_contact_pending`.
`evaluateSendGuard` is a pure function, so the panel can show the same verdict
the worker will reach.

**3. No duplicate sends.** `messages.idempotency_key` is uniquely indexed, and
`recordOutboundMessage` is the only way an outbound message is persisted. A job
retried after a crash re-derives the same key and becomes a no-op.

**4. Commercial stage and channel state are separate columns.** Progress in the
funnel never implies a channel is available, and vice versa.

**5. Nothing unverified reaches a lead.** `validateOutboundText` runs on every
outbound message regardless of who generated it, and `validateObservation`
requires every content word of a personalisation to appear in the stored public
snapshot.

**6. Ceilings only go down.** `assertCeilingRespected` refuses any request above
`MAX_DMS_PER_DAY`. The optimizer can pace below the ceiling; nothing can raise
it.

**7. Opt-out does not depend on a network call.** The rule classifier runs before
the model and short-circuits the pipeline.

**8. Nothing critical lives in process memory.** Jobs, leases, breaker state,
pauses and counters are all in SQLite.

---

## Data model

21 tables, defined in `src/db/migrations/*.sql`. The SQL is authoritative; the
Drizzle schema in `src/db/schema.ts` mirrors it and
`tests/db/schema-and-backup.test.ts` fails on drift.

Migrations are versioned and checksummed: editing an applied migration is a hard
error, not a silent divergence. Every connection runs with WAL, foreign keys on
and a busy timeout; all timestamps are ISO-8601 UTC strings.

---

## The job queue

`src/worker/queue.ts`. Claiming is a single `IMMEDIATE` transaction with an
optimistic guard on `updated_at`, so two workers cannot take the same job. Each
claim takes a `LEASE_SECONDS` lease; an expired lease is reclaimed on the next
poll, which is what makes restart recovery work without any extra machinery.

Failures carry a `retryable` flag: retryable ones get exponential backoff
(30s → 1h), everything else dead-letters straight to the operator's exception
queue. A job whose capability is unavailable is *parked*, not failed — it does
not burn attempts while Chrome is closed.

---

## Browser channel

`chromium.connectOverCDP` against the operator's own Chrome. The rules encoded
in `src/integrations/browser/cdp.ts`:

- never launch our own browser when the attach fails;
- reuse `browser.contexts()[0]`, never adopt one of the operator's tabs;
- always `context.newPage()`, always close it in a `finally`;
- never `bringToFront()`, never touch the OS mouse or keyboard;
- route-block every host outside the Instagram domains;
- one critical browser job at a time (`browserMutex`).

Element lookup goes through accessible roles and names rather than CSS classes.
Any captcha, checkpoint, "action blocked" or suspicious-activity signal raises
`account_safety_signal`, which pauses the capability and opens a critical alert.
Nothing retries a flagged session.

Three test levels: `SimulatedBrowserDriver` (CI, no browser), `pnpm dryrun:dm`
(real navigation, send blocked inside the driver), and `pnpm smoke:dm` (one real
DM, behind three independent authorisations).

---

## AI engine

`callStructured` in `src/integrations/openai/client.ts` is the only path to a
model. It enforces capability, budget and circuit breaker, then returns
schema-validated structured data — never free-form text that could drive an
action.

The engine is optional by design. Without `OPENAI_API_KEY` the system degrades
deterministically rather than pretending: openers fall back to a grounded
template, intent classification falls back to rules, and reply planning escalates
to human review instead of inventing content. The generator is recorded on every
message and shown in the panel.

Cost is never guessed. When the operator has not declared a token price the call
is still recorded with real token counts and `cost_usd = 0`, and the panel says
"preço não configurado" instead of showing a fabricated number.

---

## Testing

```bash
pnpm test
```

104 tests across 12 files. Each test file gets its own on-disk SQLite database,
so migrations, WAL and transactions behave exactly as in production. Coverage of
the invariants above: lead dedupe, pipeline and channel transitions, first
contact, browser→webhook→API handoff, channel ownership, duplicate sends, webhook
idempotency and signature, follow-up, opt-out, suppression, experiment
assignment and analysis, restart recovery, API window expiry, circuit breakers,
budget cutoff, the affiliate funnel staying disabled, business-config protection
and the verified-claims rules.

`tests/e2e/pipeline.test.ts` runs the whole funnel — discovery → qualification →
first DM → the real webhook route handler → handoff → API reply — against
simulated integrations.

---

## Conventions

Code, database, internal states, logs and this document are English. Everything
the operator reads is Portuguese, translated in `src/app/_lib/labels.ts`; that is
the only translation layer.

TypeScript is `strict` with `noUncheckedIndexedAccess`, and `any` is an ESLint
error. `console` is an error outside CLIs and the logger — structured logging
goes through `src/lib/logger.ts`, which redacts secrets by key name and by value
shape.

---

## Adding a job type

1. Add the name to `JOB_TYPES` in `src/worker/queue.ts`.
2. Write the handler in `src/worker/handlers.ts` — validate its payload with zod,
   make it idempotent, return a one-line summary.
3. Register it in `HANDLERS` (the `Record<JobType, JobHandler>` makes a missing
   entry a compile error).
4. If it needs an integration, add it to `REQUIRED_CAPABILITY` in
   `src/worker/runtime.ts` so it parks instead of failing.
5. Add a Portuguese label to `JOB_TYPE_LABELS`.
