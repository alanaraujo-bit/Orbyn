# Delivery status

What is implemented, and how far each part was actually validated. Verified on
**2026-08-30** on the operator's Windows machine (Node 24.19.0, pnpm 11.20.0).

Status vocabulary, as agreed:

- `IMPLEMENTED` — code exists and compiles
- `SIMULATION-TESTED` — exercised against controlled fakes in the test suite
- `DRY-RUN-TESTED` — exercised against the real dependency, with the final side
  effect blocked
- `INTEGRATION-TESTED` — exercised against the real dependency, for real
- `BLOCKED BY CREDENTIAL` — cannot run until the operator supplies a secret
- `BLOCKED BY ENVIRONMENT` — cannot run here for environmental reasons

---

## Verification gate

| Check | Command | Result |
| --- | --- | --- |
| Lint | `pnpm lint` | pass, 0 errors, 0 warnings |
| Type check | `pnpm typecheck` | pass, `strict` + `noUncheckedIndexedAccess` |
| Tests | `pnpm test` | 148 passing, 17 files |
| Production build | `pnpm build` | pass, 0 warnings, 13 routes |
| Panel served | `next start` + HTTP | all 10 pages return 200 |

---

## Feature status

### Configuration and business record

| Capability | Status | Evidence |
| --- | --- | --- |
| `config/business.json` as the single source of truth | INTEGRATION-TESTED | Panel, prompts, links and ICP all read from the loader; a repo-wide grep finds no business value hardcoded elsewhere |
| System can never write the business record | SIMULATION-TESTED | `tests/config/immutability.test.ts` scans the source tree for any write call against that path |
| Learned data kept separate | SIMULATION-TESTED | `strategy_state` table; the config schema is `.strict()` and rejects extra keys |
| Placeholder gating | SIMULATION-TESTED | `A DEFINIR`, empty and `null` all resolve to "not configured"; `outboundLink` returns `null` rather than a placeholder |
| Config change detection | INTEGRATION-TESTED | Fingerprint recorded at boot; changing the Instagram handle produced a new fingerprint and an audited entry |

### Customer funnel

| Capability | Status | Evidence |
| --- | --- | --- |
| Discovery with dedupe | SIMULATION-TESTED | `tests/leads/discovery.test.ts`, `tests/e2e/pipeline.test.ts` — a second discovery run creates 0 leads |
| Discovery through Instagram's public search | **INTEGRATION-TESTED** | Ran live for the first time on 2026-08-30: 5 profiles found for one keyword, 4 leads created, the own account correctly skipped. Three real defects surfaced and were fixed — the nav link's accessible name is doubled ("PesquisaPesquisa"), so an anchored `/^pesquisa$/` never matched and the path failed on step one while blaming step two; the search field is covered by an overlay while the panel animates, so clicking it is refused and focusing is the way in; and follower counts were parsed with Brazilian conventions against a meta description that groups thousands with commas, turning 3,656 followers into 4 — see `tests/integrations/follower-count.test.ts` |
| ICP scoring and qualification | SIMULATION-TESTED | Out-of-ICP profile is closed automatically |
| Manual import from the panel | INTEGRATION-TESTED | Server action reachable from `/clientes` |
| First DM over the browser | **INTEGRATION-TESTED** | One real DM delivered to the operator's own account on 2026-08-30 and confirmed in the Instagram outbox |
| Handoff to the official API | **INTEGRATION-TESTED** | Driven end to end through the real public webhook with a real HMAC signature and the live model — see `docs/meta-integration.md` |
| Reply through the official API | **INTEGRATION-TESTED (fluxo completo)** | Proven with a real person on 2026-08-30, not a synthetic payload. Browser DM sent 20:38 → the recipient replied "Oiê, me manda no whatsapp" → Instagram delivered a signed webhook 21:25:42 (`signature_valid=1`) → intent classified `wants_whatsapp` → API reply delivered 21:25:50 with an Instagram-issued `external_message_id` and `meta.delivered=true` |
| WhatsApp handoff | SIMULATION-TESTED | The e2e test asserts the outgoing text contains the real link from the business record |

### Affiliate funnel

| Capability | Status | Evidence |
| --- | --- | --- |
| Full architecture in place | IMPLEMENTED | Same pipeline, `funnel = 'affiliate'`, own stage ladder |
| Disabled until configured | SIMULATION-TESTED | Contacting an affiliate lead throws `capability_disabled`; the panel shows "Funil de afiliados aguardando configuração" |
| Enables when configured | SIMULATION-TESTED | Filling `groupLink` + `verifiedProgramClaims` flips the capability on |

**The ICP keywords found competitors, not clients — fixed on 2026-08-30.** The
first live run returned four software agencies, because `icp.keywords` described
what Aionixdev *sells* rather than how a prospect describes itself. A
`send_first_dm` job had already been queued against one of them and was
cancelled by hand. The keywords were rewritten from the operator's own ICP
segments into the prospect's vocabulary ("distribuidora", "materiais de
construção", "autopeças"...); the list is a first hypothesis and is meant to be
edited by the operator.

Fixing the keywords exposed a deeper inversion in scoring. `matchSegments`
required a long word from the segment prose to appear literally in the profile,
so the plural in "Comércios, **distribuidores** e empresas..." missed the
singular in "J.A DISTRIBUIDORA". Real prospects scored 30 against a threshold of
40 and never qualified, while the competitor — whose bio spoke the same
corporate vocabulary as the segment text — scored 50 and did. Matching on stems
corrects it: the same eight profiles now score 18-54, with five qualifying and
three correctly left out. Covered by `tests/leads/segment-matching.test.ts`.

**Orphaned workers.** `scripts/dev.mjs` spawned with `shell: true`, so on Windows
`child.kill()` reached only the intervening `cmd.exe` and the worker underneath
survived. Two orphaned workers were found leasing from the same queue as their
replacement. The script now kills the whole process tree, including on a hard
exit.

**One remaining blocker, by design:** `affiliateProgram.groupLink` is `"A DEFINIR"` in
the business record, so no affiliate outreach can leave the system. Fill that
field and add at least one verified program claim to enable it.

### Channels

| Capability | Status | Evidence |
| --- | --- | --- |
| Chrome over CDP, loopback only | INTEGRATION-TESTED | Attached to Chrome 152 on `127.0.0.1:9222`; non-loopback URLs are refused by env validation |
| Own tab, closed in `finally`, no `bringToFront` | INTEGRATION-TESTED | Observed during the real dry run; the operator's tabs were untouched |
| Failure evidence capture | INTEGRATION-TESTED | Screenshot + ARIA snapshot written on every failure path exercised |
| Safety-signal detection and pause | SIMULATION-TESTED | Six signal shapes covered; the capability pauses and a critical alert opens |
| Official API client | INTEGRATION-TESTED | Token generated; `GET /me`, `/me/conversations` and `POST /me/messages` all exercised against the live API — see `docs/meta-integration.md` |
| Webhook receiver | INTEGRATION-TESTED | Handshake, real HMAC signature, tampering and duplicate delivery all exercised over the public internet |
| Public-address watchdog | INTEGRATION-TESTED | Every 5 min the worker re-runs Meta's handshake against the public URL with a fresh challenge, re-reading `.env` each time so a tunnel restart is picked up without restarting the worker. Two attempts per check absorb a dropped packet; the first bad check opens a **warning**, the next consecutive one escalates the same alert to **critical**, and recovery resolves it — `tests/system/webhook-reachability.test.ts` |

### Real browser run (dry run), 2026-08-30

Command: `pnpm dryrun:dm @natgeo`

1. Attached to the operator's Chrome over CDP and opened its own tab.
2. Navigated to the real profile; no safety signal detected.
3. Found the "Enviar mensagem" control by accessible name.
4. Opened Instagram's chat widget and located the composer.
5. **Stopped**, captured evidence and printed the message that would have been
   sent. The screenshot shows the composer open and empty.

Two real defects were found and fixed during this run:

- the composer lookup assumed a `/direct/` navigation, while Instagram opens a
  floating widget on the profile page — the lookup is now anchored on the
  textbox that appears after the click, which also prevents ever typing into the
  search field;
- closing a lead was not idempotent, so a second terminal outcome threw
  `invalid_state_transition`.

Earlier attempts against a non-existent profile produced `profile_not_found`,
which also confirmed the not-found branch against the live site.

### Panel exposure and access

The tunnel forwards **every** path to port 4310, not only
`/api/webhooks/instagram`. So for as long as `pnpm tunnel` runs, the whole
operator panel answers on the public hostname — lead data, message contents, and
the actions that schedule a real DM. That was true from the first tunnel of
2026-08-30 and nothing recorded it.

| Capability | Status | Evidence |
| --- | --- | --- |
| Panel behind a password | INTEGRATION-TESTED | `src/proxy.ts` closes every route by default. Verified against the running panel: `/` and `/clientes` redirect to `/entrar`, a wrong password is refused, the right one sets a session cookie and `/clientes` then returns 200 |
| Webhook stays open | INTEGRATION-TESTED | `/api/webhooks/instagram` still answers Meta's handshake with the exact challenge echoed — Meta calls it unauthenticated, and closing it would have silently killed the inbound half |
| Session secret never stored | IMPLEMENTED | The cookie carries an HMAC of the password, not the password; comparison is constant-time |
| No open redirect on sign-in | INTEGRATION-TESTED | A `destino` outside the panel falls back to `/`; exercised with an external URL |
| Shell hidden when signed out | IMPLEMENTED | The root layout renders a bare page for unauthenticated requests, so the company name, alert counts and capability list do not leak on the sign-in screen |

Next 16 renamed the `middleware.ts` convention to `proxy.ts`. A file named
`middleware.ts` is ignored without warning — it would have looked protected and
been wide open.

### Engine, safety and operations

| Capability | Status | Evidence |
| --- | --- | --- |
| Verified-claims enforcement | SIMULATION-TESTED | 13 policy tests; every unverified-claim shape is refused |
| Grounded observations | SIMULATION-TESTED | An inference not present in the stored snapshot is rejected |
| Opt-out, immediate and terminal | SIMULATION-TESTED | Detected by rules with no network call; jobs cancelled, handle suppressed, no goodbye message |
| Durable jobs, retry, dead letter | SIMULATION-TESTED | 11 queue tests |
| Restart recovery | SIMULATION-TESTED | An abandoned lease is reclaimed and the job completes |
| Circuit breakers | SIMULATION-TESTED | Open, block, and survive a restart |
| Ceilings cannot be raised | SIMULATION-TESTED | Warm-up, daily cap, operating hours; the optimizer writing an absurd warm-up still caps at `MAX_DMS_PER_DAY` |
| AI cost ledger and budget cutoff | INTEGRATION-TESTED | Real calls priced, including a measured prompt-cache hit at 88.5% saving |
| Experiments and optimizer | SIMULATION-TESTED | No winner without sample; exposure moves gradually and keeps exploration |
| Retention and anonymisation | SIMULATION-TESTED | Expired leads anonymised, active customers preserved |
| Backup and restore | SIMULATION-TESTED | Backup verified, restore reversible via a pre-restore copy |
| Panel | INTEGRATION-TESTED | All pages served and rendered from the live database |

---

## Blocked, and how to unblock

| Blocker | Effect | To unblock |
| --- | --- | --- |
| Inbound from strangers | **NOT a blocker — disproven on 2026-08-30** | Standard Access ("Pronto para teste") was assumed to gate inbound traffic to accounts holding a role on the app. A real DM from an unrelated account (`<conta-de-terceiro>`, no role) was delivered over the public webhook with a valid signature at 23:53:07 and processed in 1.6s. App Review is **not** required to receive. What remains untested is the reverse: an **API reply to a stranger**, since the funnel correctly ignores senders it never prospected |
| Public address | **Fixed since 2026-08-30.** `pnpm tunnel` now uses a reserved ngrok domain when `NGROK_DOMAIN` is set in `.env`, and falls back to a Cloudflare quick tunnel otherwise. The Callback URL is registered at Meta once and survives restarts. One isolated HTTP 404 was observed at 00:10:59 (the ngrok edge with no agent attached) and cleared itself; a 24-probe sweep over the following 3 minutes was clean. The watchdog is what makes this safe to rely on: a real outage warns within 5 minutes |
| `affiliateProgram.groupLink` is `"A DEFINIR"` | Affiliate funnel disabled | Fill the field and add a verified program claim |
| Real DM never sent | By design | `pnpm smoke:dm -- --handle @seu_perfil --i-authorize-real-dm` |

Both halves have now run for real, end to end: an outbound DM over the browser,
a real reply carried by Instagram's own signed webhook, and an API answer that
Instagram accepted and delivered (2026-08-30, 20:38 → 21:25).

The one open question — whether Standard Access confines this to accounts with a
role on the app — was settled at 23:53 the same day by a DM from an unrelated
account. It arrived, signed and intact. Receiving does not need App Review.

The remaining untested edge is narrow and specific: **an API reply delivered to
a stranger**. Every API send so far went to an account holding a role. The
funnel refuses to answer senders it never prospected, so proving this needs a
prospected lead who replies — the ordinary path, just not yet walked end to end
with an outside account.

**Correction, 2026-08-30 (second session).** An earlier version of this file
named "app unpublished" as the one blocker and called publication "one click".
Checking the panel directly showed the app was already published and that the
real gate is App Review. Two smaller claims in
[`docs/meta-integration.md`](./meta-integration.md) did not survive the same
check either: `instagram_business_manage_comments` is **not** added to the use
case (its row offers "Adicionar"), and saving a new Callback URL requires
re-entering the verify token, so the address cannot be rotated by the panel
alone.

## Meta integration

Fully documented, with per-stage evidence, in
[`docs/meta-integration.md`](./meta-integration.md). Summary: identifiers
recorded, tester accepted, token generated and validated against the live API,
webhook endpoint verified by Meta over the public internet, all message fields
subscribed, account subscription enabled. One production defect in Graph error
classification was found and fixed in the process.
