---
title: "Phase 1: Tenant Isolation"
type: feat
status: active
date: 2026-08-13
origin: docs/brainstorms/2026-08-13-tenant-isolation-requirements.md
deepened: 2026-08-13
---

# Phase 1: Tenant Isolation

## Overview

`distributed-webhook-dlq` currently has one shared `API_KEY` — any caller can list, read, or replay any job regardless of who created it. This plan gives each of the user's projects its own API key, tags every job with the tenant that created it, and scopes all four `/webhooks` routes so a tenant can only ever see or act on its own jobs.

---

## Problem Frame

Phase 0 (merged) built the extension point for this: `resolveTenant(key)` in `src/auth/apiKey.ts` already runs on every request and attaches `req.tenant` to it, but currently returns a hardcoded placeholder (`{ id: "default" }`) for any valid key, and nothing downstream reads `req.tenant` at all. `WebhookJob` has no ownership field, and `jobStore.ts`'s `getJob`/`getJobsByStatus` return data with zero awareness of who's asking. This is the actual gap: not "is there an extension point" (there is), but "does anything use it yet" (nothing does). (See origin: `docs/brainstorms/2026-08-13-tenant-isolation-requirements.md`.)

---

## Requirements Trace

- R1. The service supports multiple named tenants, each with its own API key, configured via a static config source loaded at startup.
- R2. `resolveTenant` looks up the provided key against that config and returns the matching tenant id.
- R3. Adding, removing, or rotating a tenant's key is done by editing config and restarting — no admin endpoint.
- R4. Every job created records which tenant created it.
- R5. `GET /webhooks?status=X` only returns jobs belonging to the caller's own tenant.
- R6. `GET /webhooks/:id` returns `404` for a job that exists but belongs to a different tenant.
- R7. `POST /webhooks/:id/replay` is scoped the same way — `404` for a different tenant's job.
- R8. All tenants share the same global operational behavior (`MAX_ATTEMPTS`, SSRF blocklist, backoff timing) — no per-tenant configuration in this phase.

**Origin acceptance examples:** AE1 (covers R6, R7), AE2 (covers R5)

---

## Scope Boundaries

- Self-service tenant/key provisioning (an endpoint or UI) — not needed at this scale (2-5 known projects the user controls personally).
- Per-tenant configuration (retry limits, allowed destination domains, etc.) — deferred; all tenants share global behavior (R8).
- Key rotation tooling beyond "edit config, restart."
- Tenant-level rate limiting or quotas.
- Migrating existing pre-Phase-1 jobs in Redis to a specific tenant — see U2 Approach.
- Indexing `getJobsByStatus` for tenant-scoped lookups (e.g., a secondary per-tenant Redis set) — it remains the same `SCAN`-based approach from Phase 0's original design, now filtering on two fields (status and tenant) instead of one. Already documented as a known scaling limit; not addressed further here.

---

## Context & Research

### Relevant Code and Patterns

- `src/auth/apiKey.ts` — `resolveTenant(key: string): Tenant | null` currently does a single-secret `timingSafeEqual` check against `process.env.API_KEY`, returning a hardcoded `{ id: "default" }` on match. `apiKeyAuth` middleware (Express-coupled) calls it and attaches `req.tenant`; `Tenant` is `{ id: string }`. Zero-Express-coupling constraint on `resolveTenant` established in Phase 0 — preserve it.
- `src/types.ts` — `WebhookJob` has no tenant field today: `{ id, url, payload, status, createdAt, updatedAt, attempts }`.
- `src/store/jobStore.ts` — module-private `const redis = new Redis(redisConnection)`, only narrow functions exported (`createJob`, `getJob`, `updateJob`, `incrementAttempts`, `resetAttempts`, `getJobsByStatus`). `getJobsByStatus(status)` does a `SCAN MATCH job:*` + `MGET` + in-memory status filter with zero tenant awareness — this is the exact point that needs tenant filtering added.
- `src/routes/webhooks.ts` — `webhooksRouter.use(apiKeyAuth)` applied router-wide before all four route definitions (self-protecting by design, from Phase 0). None of the four routes currently read `req.tenant`.
- `src/redisConnection.ts` / `.env.example` — established env-var convention: `process.env.X ?? <default>` for non-secrets with a safe default; required-with-no-default, fail-closed for secrets (the `API_KEY` pattern from Phase 0). A new `API_KEYS` var follows the latter.
- Test infra: `node:test` + `node:assert/strict`, no mocking framework anywhere in the repo. Tests run against a real `ioredis` client and real `express.listen()` servers, with manual key cleanup in `test.after`. `src/auth/apiKey.test.ts`'s `withApiKey(value, fn)` helper (saves/restores `process.env.API_KEY` around a test) is the established pattern for env-var-dependent tests — this phase's config change means that helper (and every test that sets `process.env.API_KEY`) needs updating to the new `API_KEYS` shape.
- No config-parsing library exists in `package.json` (no `zod`, `dotenv`, `convict`) — `JSON.parse` is the only primitive available and is already used raw elsewhere (`jobStore.ts`'s `parseJob`). A JSON-blob env var needs no new dependency.

### Institutional Learnings

None — `docs/solutions/` does not exist in this repo yet.

### External References

- This is **BOLA (Broken Object Level Authorization)** — OWASP API Security Top 10 #1, unchanged through 2025/2026 guidance. Core prevention principle: push the ownership filter into the data-access layer itself (`WHERE tenant_id = ? AND id = ?` in a SQL analogy) rather than "fetch by id, then check owner in the route handler afterward." The fetch-then-check pattern is the more regression-prone shape — a future route can copy the fetch call and simply forget the `if` check, with nothing failing loudly. Filtering at the access layer makes the unauthorized case indistinguishable from "not found" by construction.
- `404` (not `403`) for cross-tenant access to a private, non-public record is confirmed current best practice — `403` leaks that the resource exists at all. The one known caveat (response-time side channels distinguishing "doesn't exist" from "exists but hidden") is a real but low-priority residual risk for a small, non-adversarial set of known consumers, not worth engineering around here.
- Recommended static-config shape for a handful of known API consumers: a single JSON blob in one env var (e.g. `API_KEYS='{"key-abc":"tenant-a","key-def":"tenant-b"}'`), parsed once at boot into a `Map<string, string>`. This beats a delimited string (fragile parsing, no room to grow) and beats one-env-var-per-tenant (doesn't scale, awkward to iterate). It also maps cleanly onto a future DB-backed `api_keys` table if that ever becomes necessary, so swapping the lookup implementation later stays a one-function change.
- Centralize the ownership check in exactly one place (the store layer, not duplicated per route) — the OWASP-cited common regression path is exactly "the check exists in route A but was forgotten when route B was added."

---

## Key Technical Decisions

- **Store-level filtering, not fetch-then-check in route handlers.** `getJob` and `getJobsByStatus` both require a `tenantId` parameter — there is no unscoped variant *exported*. `getJob(id, tenantId)` returns `undefined` both when the id doesn't exist *and* when it belongs to a different tenant, making the two cases structurally indistinguishable rather than relying on a route handler to remember an `if` check. Redis's key-by-id shape means this isn't a true SQL-style `WHERE` pushdown, but the same principle — "the check is required by the function signature, not optional" — is preserved for every caller outside `jobStore.ts`. (Addresses R6, R7; per BOLA research above.)
- **A private, non-exported `getJobUnscoped(id)` remains inside `jobStore.ts` for the module's own internal use.** `updateJob`, `incrementAttempts`, and `resetAttempts` already fetch-by-id internally today to perform their read-modify-write; requiring `tenantId` on the public `getJob` doesn't change that they still need an internal, unscoped fetch primitive to do their job. The module boundary *is* the trust boundary here: these three functions are only ever reached by route code after an authorized `getJob` already succeeded, or by the worker acting on a job it already holds from the queue — never with an attacker-controlled id and no prior authorization step. Caught during plan review: the original wording ("no unscoped variant left callable") overstated this — the accurate claim is "no unscoped variant is exported or callable from outside the store module."
- **Rejected: keying jobs by `job:<tenantId>:<id>` in Redis instead of `job:<id>` + a `tenantId` field.** Considered and rejected for now, not simply unaddressed. This phase has no per-tenant Redis ACLs or credentials (R8, single module-private `redis` client) — in *either* key scheme, the actual trust boundary is "the application code passes the correct `tenantId`," so a prefixed key wouldn't make cross-tenant access structurally impossible, only relocate the same trust requirement from a post-fetch field comparison to a pre-fetch string interpolation. It would, however, let `getJobsByStatus` scope its `SCAN` to `job:<tenantId>:*` — a real, cheap mitigation for the scaling limitation this plan otherwise defers (see Scope Boundaries) — at the cost of forcing `tenantId` into `updateJob`/`incrementAttempts`/`resetAttempts`, and therefore into `worker.ts` (which currently only has the bare job object from the queue). The field-based approach keeps that blast radius contained. If `getJobsByStatus`'s unindexed `SCAN` ever becomes a real bottleneck, tenant-prefixed keys are the natural mechanism to revisit — noted here so a future phase doesn't have to rediscover this tradeoff.
- **`404`, not `403`, falls out of the store design above for free.** Since a wrong-tenant lookup and a nonexistent lookup return the identical `undefined`, the route code has exactly one branch to write (`if (!job) return 404`), not two.
- **Static config as a single JSON-blob env var (`API_KEYS`), parsed once at module load into a `Map<string, string>`.** Chosen over delimited strings or per-tenant env vars per the research above. `API_KEY` (singular, from Phase 0) is fully replaced, not kept as a parallel fallback — two parallel auth code paths would be a long-term maintenance cost for no real benefit, even though it means updating Phase 0's existing tests and any real deployment already using `API_KEY`.
- **Multi-key lookup uses `Map.get`, not a `timingSafeEqual` loop over every configured key — with the actual mechanism spelled out, not asserted.** V8's `Map.get(key)` hashes the candidate string (cost proportional to the *attacker-supplied* string's length, not any secret — not itself a leak) and looks up its bucket; a bucket miss (the overwhelming majority of wrong guesses against a well-distributed hash) returns `undefined` with **zero** content comparisons against any real key. Only a hash-bucket collision falls through to an ordinary (non-constant-time) string compare — a materially smaller exposure than a naive N-key loop of plain `===`, but not literally timing-equivalent to `timingSafeEqual`. Exploiting it requires first finding a bucket collision against one of a handful of secrets, then extracting single-digit-nanosecond signal through real HTTP/network jitter across many requests — infeasible for this consumer set (2-5 known, non-adversarial projects), which is why the plan accepts it rather than reintroducing a linear timing-safe scan across N keys for no practical benefit here.
- **`API_KEYS` entries with an empty-string key or empty-string tenant id are rejected at boot, not silently accepted.** This is the direct structural analog of the exact bug Phase 0 closed: `crypto.timingSafeEqual` doesn't throw on two zero-length buffers, and here, a config-authoring mistake producing `{"": "tenant-x"}` would let `Map.get("")` succeed — meaning `Authorization: Bearer ` (empty token, already syntactically reachable through `apiKeyAuth`'s header parsing) would authenticate as that tenant. Boot-time validation closes this before it can ever reach a request.
- **`resolveTenant` keeps its zero-Express-coupling constraint from Phase 0** — it still takes a plain string and returns `Tenant | null`, only the lookup source changes (config-parsed `Map` instead of a single `process.env.API_KEY` comparison).

---

## Open Questions

### Resolved During Planning

- Exact field name/shape for tenant ownership on `WebhookJob`?: `tenantId: string`, alongside the existing fields.
- Does `getJobsByStatus` need a tenant parameter, or does filtering happen at the route layer?: Store layer — `getJobsByStatus(status, tenantId)` filters both fields in the same pass, per the BOLA research (route-layer-only filtering is the regression-prone shape).
- Exact config format?: Single JSON-blob env var (`API_KEYS`), parsed into a `Map<string, string>` at module load. See Key Technical Decisions.
- What should happen on malformed `API_KEYS` JSON at boot — crash the process, or fail closed?: Fail closed, not crash. This repo has no multi-replica/health-check-gated deployment (no `Dockerfile`, no orchestration config found), so a single running instance is the realistic topology — crashing at import time (before `app.listen` ever runs) would take down the entire API, including the unauthenticated `/health` route and the ability to accept new webhooks at all, with no automatic recovery. Fail-closed matches Phase 0's own precedent for unset `API_KEY` (empty `Map`, every request 401s) and is equivalent from a "nobody gets in" security standpoint, but with much smaller blast radius. Log the parse failure loudly (a clearly distinguishable error line) so it's discoverable, but don't exit the process. Note the resulting asymmetry: `src/worker/run.ts` never imports `apiKey.ts`, so a broken `API_KEYS` config degrades the API (new webhooks can't be created or read) while the worker keeps draining whatever's already queued — intentional partial degradation, not a bug, but worth knowing.

### Deferred to Implementation

- Exact error-log format/wording for a malformed-`API_KEYS` boot failure (see above for the fail-closed-not-crash decision itself, already resolved).

---

## Implementation Units

- [x] U1. **Multi-key tenant lookup**

**Goal:** Replace the single-secret `resolveTenant` check with a config-driven multi-tenant lookup.

**Requirements:** R1, R2, R3

**Dependencies:** None

**Files:**
- Modify: `src/auth/apiKey.ts`
- Test: `src/auth/apiKey.test.ts`
- Modify: `.env.example` (replace `API_KEY` with `API_KEYS`)

**Approach:**
- Parse `API_KEYS` (a JSON object of `apiKey -> tenantId` pairs) once at module load into a `Map<string, string>`.
- `resolveTenant(key)` looks up `key` in the map; returns `{ id: tenantId }` on a hit, `null` on a miss — same return shape as today, same zero-Express-coupling constraint.
- Fail closed, not crash, on a parse problem: if `API_KEYS` is unset, empty, or fails `JSON.parse`, log a clearly distinguishable error line and fall back to an empty `Map` — every request then correctly 401s, matching Phase 0's existing unset-`API_KEY` behavior, without taking the whole process down (see Open Questions for why crashing is the wrong default given this repo's single-instance deployment shape).
- Reject (treat as a parse failure, same fail-closed path above) any parsed entry with an empty-string key or empty-string tenant id — closes the empty-string `Map.get("")` bypass described in Key Technical Decisions.
- Do not keep `API_KEY` (singular) as a fallback — this is an intentional breaking change from Phase 0 (see Key Technical Decisions).

**Patterns to follow:**
- `src/auth/apiKey.ts`'s existing fail-closed structure and `Tenant` interface — extend, don't replace the shape.
- `withApiKey`-style env-var save/restore helper already in `src/auth/apiKey.test.ts` — adapt it for the new `API_KEYS` JSON shape.

**Test scenarios:**
- Happy path: a key present in `API_KEYS` resolves to its corresponding tenant id.
- Happy path: two different keys in the same `API_KEYS` config resolve to two different, correct tenant ids.
- Error path: a key not present in `API_KEYS` returns `null`.
- Edge case: `API_KEYS` unset, empty string, or malformed JSON — every lookup returns `null` (fail closed), matching Phase 0's existing unset-`API_KEY` test intent. The process must not crash/exit in any of these cases.
- Edge case: `API_KEYS` containing an empty-string key (e.g. `{"": "tenant-x"}`) is rejected — a request with `Authorization: Bearer ` (empty token) must not authenticate as `tenant-x`.
- Regression: existing `apiKeyAuth` middleware tests (missing header, malformed header, wrong scheme) still pass unchanged, since only the lookup source inside `resolveTenant` changes, not the middleware contract.

**Verification:**
- All test scenarios pass under `npm test`.
- Manually confirmed: two different keys against a running server each reach a route successfully and (once U3 lands) see only their own data.

---

- [x] U2. **Tenant-scoped job store**

**Goal:** Make ownership-aware lookups the only way to read a job from outside the store module — no unscoped `getJob`/`getJobsByStatus` remains exported.

**Requirements:** R4, R5, R6, R7

**Dependencies:** None (independent of U1; both feed U3 — but see the note on shared test files in System-Wide Impact before landing U1/U2 separately)

**Files:**
- Modify: `src/types.ts` (add `tenantId` to `WebhookJob`)
- Modify: `src/store/jobStore.ts`
- Test: `src/store/jobStore.test.ts` (new file — no direct store-level tests exist today; coverage has been indirect via route tests)
- Test: `src/worker/worker.test.ts` (its `buildJob()` helper constructs `WebhookJob` objects and needs a `tenantId` field once that's required on the type; its direct `getJob(job.id)` calls need updating to the new signature)

**Approach:**
- Add `tenantId: string` to `WebhookJob`.
- Introduce a private, non-exported `getJobUnscoped(id)` inside `jobStore.ts` for the module's own internal use — `updateJob`, `incrementAttempts`, and `resetAttempts` already fetch-by-id internally today to do their read-modify-write, and that internal need doesn't go away just because the *public* `getJob` now requires `tenantId`. These three functions keep operating by bare `id`, unchanged in their exported signature, using the private helper internally (see Key Technical Decisions for why this is a legitimate, deliberate exception rather than a loophole).
- Change the exported `getJob(id, tenantId)`: fetch via the private helper, then return `undefined` unless the stored job's `tenantId` matches the caller's — same external return type, no new "forbidden" branch, no separate unscoped variant exported.
- Change `getJobsByStatus(status, tenantId)`: filter on both status and tenantId in the existing `SCAN`+`MGET` pass. Same underlying approach as today (see Scope Boundaries — not indexing this further). Note this pass briefly holds every tenant's full job payload in process memory before filtering discards non-matches — inherent to the unindexed design, not new, but avoid ever logging or dumping raw `MGET` results given this.
- `createJob` is unaffected. `updateJob`, `incrementAttempts`, `resetAttempts` keep their exported signatures (operate by bare `id`, via the private helper) — once a caller has an authorized job (via the scoped `getJob`), further mutation by id needs no repeated ownership check.
- Existing pre-Phase-1 jobs in Redis have no `tenantId` (`undefined`). A comparison against any real tenant id is simply `false`, so these records become permanently inaccessible via the exported, scoped API without any special-case code or crash — matches the origin document's accepted assumption.

**Patterns to follow:**
- `src/store/jobStore.ts`'s existing module-private-client, narrow-exported-functions convention — extend the existing functions' signatures, don't introduce a class or new construction pattern.

**Test scenarios:**
- Happy path: `getJob(id, tenantId)` returns the job when the tenant matches.
- Error path: `getJob(id, wrongTenantId)` returns `undefined` for a job that exists but belongs to another tenant.
- Error path: `getJob(nonexistentId, anyTenantId)` returns `undefined` — same shape as the wrong-tenant case, confirming they're indistinguishable (Covers AE1).
- Happy path: `getJobsByStatus(status, tenantId)` returns only that tenant's matching jobs when jobs from multiple tenants share the same status (Covers AE2).
- Edge case: a job created before this phase (no `tenantId` field, simulated directly via a raw Redis write bypassing `createJob`) is not returned by `getJob` or `getJobsByStatus` for any real tenant id — confirms the "orphaned, not crashing" behavior.
- Regression: `updateJob`, `incrementAttempts`, and `resetAttempts` still function correctly by bare `id` after the internal `getJobUnscoped` refactor — confirms the private-helper extraction didn't change their externally-observable behavior.

**Verification:**
- All test scenarios pass under `npm test`.
- `npm run typecheck` passes with `tenantId` required on every `WebhookJob` construction site.
- `getJobUnscoped` does not appear in `jobStore.ts`'s exports.

---

- [x] U3. **Wire tenant scoping into the routes**

**Goal:** Every `/webhooks` route uses the tenant-scoped store functions from U2 and the resolved tenant from U1 — no route reads or writes a job without going through them.

**Requirements:** R4, R5, R6, R7

**Dependencies:** U1, U2

**Files:**
- Modify: `src/routes/webhooks.ts`
- Modify: `src/routes/webhooks.test.ts`
- Modify: `src/queue/queue.ts` (add `removeOnComplete`/`removeOnFail` to `enqueue`'s `queue.add` options)

**Approach:**
- `POST /webhooks`: attach `req.tenant.id` to the constructed `WebhookJob` before `createJob`.
- `GET /webhooks/:id`: call `getJob(id, req.tenant.id)`; `404` on `undefined` (already existing shape, just now tenant-aware).
- `GET /webhooks?status=`: call `getJobsByStatus(status, req.tenant.id)`.
- `POST /webhooks/:id/replay`: call `getJob(id, req.tenant.id)` first; `404` on `undefined` (before the existing `DEAD_LETTER`-status check, so a cross-tenant caller can't distinguish "not yours" from "yours but not DEAD_LETTER" by response shape — both should look identical to "not found").
- Small, related data-hygiene fix while touching this area: configure `removeOnComplete`/`removeOnFail` on `queue.ts`'s `enqueue` call so BullMQ stops retaining every job's full (now tenant-tagged) data indefinitely in its own keyspace (see System-Wide Impact and Risks & Dependencies). This doesn't add tenant scoping to BullMQ's own data — it reduces how long an unscoped copy exists.

**Patterns to follow:**
- Existing route structure and `{ error }` response shape in `src/routes/webhooks.ts`.

**Test scenarios:**
- Happy path: tenant A creates a job, then reads it back via `GET /webhooks/:id` with tenant A's key — succeeds.
- Error path: tenant A creates a job; tenant B's key against the same id on `GET /webhooks/:id` returns `404` (Covers AE1).
- Error path: tenant A creates a job; tenant B's key against `POST /webhooks/:id/replay` for that id returns `404`, and the job's status/attempts are unchanged (Covers AE1).
- Happy path: tenant A has jobs in multiple statuses, tenant B has jobs in the same statuses; `GET /webhooks?status=X` with tenant A's key returns only tenant A's matching jobs (Covers AE2).
- Regression: the full existing happy-path flow (create → `QUEUED` → delivery → `DELIVERED`) still works unchanged for a single tenant, matching Phase 0's existing coverage.
- Integration: a job created via one tenant's key and later replayed via the *same* tenant's key still works end-to-end (proves scoping isn't accidentally over-restrictive for the legitimate owner).
- Edge case: for both `GET /webhooks/:id` and `POST /webhooks/:id/replay`, the JSON response body for a cross-tenant `404` is byte-identical to the body for a genuinely nonexistent id — not just the same status code. Locks in the "indistinguishable by construction" property so a later change (e.g. adding a debug field to one branch) can't quietly reopen the response-shape side channel noted in Risks & Dependencies.
- Integration: after a job completes delivery, its record no longer persists in BullMQ's own Redis keyspace (confirms `removeOnComplete`/`removeOnFail` is actually wired up, not just present in the diff).

**Verification:**
- All test scenarios pass under `npm test`.
- Manually confirmed via curl: two different `API_KEYS` entries, each creating and listing jobs, never see each other's data.

---

- [x] U4. **Config and docs**

**Goal:** Document the `API_KEYS` format and the tenant-scoping behavior so the migration from Phase 0's single-key setup is unambiguous.

**Requirements:** Supports R1, R3 (usability of the breaking config change)

**Dependencies:** U1, U2, U3

**Files:**
- Modify: `.env.example`
- Modify: `README.md`

**Approach:**
- `.env.example`: replace `API_KEY` with `API_KEYS`, showing the JSON-object format with at least two example entries.
- README: update the Security section to describe per-tenant keys and the `404`-on-cross-tenant behavior; note the breaking change from Phase 0's single `API_KEY` explicitly, so a reader who set up Phase 0 knows to migrate.

**Test scenarios:**
- Test expectation: none — documentation only.

**Verification:**
- A reader who previously configured Phase 0's `API_KEY` can tell, from the README alone, exactly what changed and how to migrate to `API_KEYS`.

---

## System-Wide Impact

- **Interaction graph:** `src/auth/apiKey.ts`'s `resolveTenant` change affects every request through `webhooksRouter` (all four routes, via the existing router-wide `apiKeyAuth` mount). `src/store/jobStore.ts`'s signature changes affect `src/routes/webhooks.ts` directly. `worker.ts`'s *production code* is not affected — it only calls `updateJob`/`incrementAttempts` by bare id (unchanged exported signatures), never `getJob`/`getJobsByStatus`, since it operates on the job object handed to it by the queue. Its *test file* (`worker.test.ts`) does need a small update (see U2 Files) since it constructs `WebhookJob` objects directly and calls `getJob` in a couple of assertions.
- **API surface parity:** all three job-reading paths (`GET /webhooks/:id`, `GET /webhooks?status=`, `POST /webhooks/:id/replay`'s internal lookup) must go through the same U2 functions. This is exactly the regression class BOLA/IDOR research warns about — a future route that fetches a job by id outside `getJob(id, tenantId)` would silently reopen cross-tenant access. U2's design (no unscoped variant *exported*) is the structural defense against this, not just a convention to remember.
- **Cross-unit test file overlap:** `src/routes/webhooks.test.ts` and `src/auth/apiKey.test.ts` both currently set `process.env.API_KEY` directly, and both are touched by more than one unit (U1 changes the auth mechanism those tests exercise; U3 adds tenant-scoping assertions to `webhooks.test.ts`). U1 is listed as having no *code* dependency on U2/U3, and that's accurate for the production source — but U1 and U3 are not independently shippable in a green state, because landing U1 alone leaves `webhooks.test.ts` still setting the now-inert `API_KEY` var, failing every request in that suite with `401`. Land U1, U2, and U3 as a single changeset (consistent with how Phase 0 actually shipped — incremental commits, one PR), not as three independently-mergeable units.
- **A second, unscoped copy of job data exists outside this plan's reach: BullMQ's own Redis keyspace.** `queue.ts`'s `enqueue` (`queue.add("deliver", job, { attempts: 1 })`) passes no `removeOnComplete`/`removeOnFail` options, so BullMQ retains every job's full data — including `url`, `payload`, and (after this phase) `tenantId` — indefinitely in its own keyspace (`bull:webhook-deliveries:*`), completely outside every scoping guarantee U2/U3 add. Nothing reads from that keyspace today, so it isn't yet exploitable via the HTTP API, but it means U2's "nothing insecure left to accidentally call" claim is true for `jobStore.ts` specifically, not for the system as a whole — a future ops dashboard, Bull Board integration, or direct Redis access would see all tenants' data unfiltered. See Risks & Dependencies.
- **Unchanged invariants:** `worker.ts`'s delivery/retry logic, the `JobStatus` enum, the SSRF guard (`src/security/ssrfGuard.ts`), and `src/security/ssrfGuard.test.ts` are untouched by this phase.
- **Integration coverage:** unit-level `jobStore.test.ts` coverage (U2) proves the filtering logic in isolation; `webhooks.test.ts` coverage (U3) proves the full HTTP-request-to-Redis-record path enforces it end to end — neither alone proves the other, both are needed.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `API_KEY` → `API_KEYS` is a breaking config change: Phase 0's existing tests and any real deployment already using `API_KEY` will break until updated | U1 updates every existing test that sets `process.env.API_KEY`; README (U4) documents the migration explicitly. Low real-world impact since this project isn't deployed for real yet. |
| A future route or code path fetches a job by id without going through the tenant-scoped `getJob`, silently reopening cross-tenant access | U2's design leaves no unscoped variant exported from `jobStore.ts` — the only unscoped fetch primitive is a private helper used exclusively by the store module's own trusted mutators, never reachable from route code. Nothing insecure is left callable from outside the module (BullMQ's own data copy is a separate, tracked exception — see the row below). |
| Existing pre-Phase-1 job data in Redis becomes permanently inaccessible once tenant scoping is enforced | Explicitly accepted in the origin document (personal project, disposable test data); U2 confirms this fails safe (orphaned, not crashing) rather than fails open. |
| Response-time side channel could theoretically distinguish "job doesn't exist" from "job exists but isn't yours" even with identical `404` responses | Accepted as a low-priority residual risk for a small, non-adversarial set of known consumers (per external research); not engineered around in this phase. |
| BullMQ retains every job's full data (including `tenantId`, `url`, `payload`) indefinitely in its own Redis keyspace, unscoped by tenant and outside `jobStore.ts`'s guarantees entirely (see System-Wide Impact) | U3 configures `removeOnComplete`/`removeOnFail` on the queue as data-hygiene cleanup (reduces retention window; not full remediation — the copy still briefly exists). Any future feature reading BullMQ job state directly (dashboards, admin tooling, `redis-cli`/backup access) must apply the same tenant scoping as the HTTP routes, since it doesn't come for free from this plan's design |
| A malformed `API_KEYS` value at boot could take down the whole service if handled by crashing the process, given this repo has no multi-replica/health-check-gated deployment to catch a bad rollout | Resolved as an explicit decision, not left as an implementation detail: fail closed (empty `Map`, every request 401s) with a loud log line, not a process exit — see Open Questions and U1 |

---

## Documentation / Operational Notes

- README's Security section gains the per-tenant key format and migration note (U4).
- Consider `/ce-compound` after this phase lands — the store-level-filtering-over-fetch-then-check pattern and the `404`-falls-out-for-free design are exactly the kind of reusable decision worth capturing in `docs/solutions/` for future phases or future projects.

---

## Sources & References

- **Origin document:** [docs/brainstorms/2026-08-13-tenant-isolation-requirements.md](../brainstorms/2026-08-13-tenant-isolation-requirements.md)
- [API1:2023 Broken Object Level Authorization — OWASP](https://owasp.org/API-Security/editions/2023/en/0xa1-broken-object-level-authorization/)
- [Returning HTTP 404 Instead of 403 for Unauthorised Access](https://dev.to/ashallendesign/returning-http-404-responses-instead-of-403-for-unauthorised-access-22ba)
- [IDOR Vulnerabilities: The Complete Technical Guide (2026)](https://codeant.ai/blogs/idor-vulnerabilities)
- Related code: `src/auth/apiKey.ts`, `src/store/jobStore.ts`, `src/routes/webhooks.ts`, `src/types.ts`, `.env.example`
- Related PR: #7 (Phase 0: SSRF protection + API key auth)

---

## Deferred / Open Questions

### From 2026-08-19 review

- **Unscoped write primitives undercut the plan's own centralized-ownership-check claim** — Key Technical Decisions / Risks & Dependencies (P1, adversarial, confidence 75)

  The plan's headline security claim is that BOLA is prevented structurally because "there is no unscoped variant exported" from `jobStore.ts`, and the Risks table states outright that "nothing insecure is left callable from outside the module." That is true only for reads. `updateJob(id, status)`, `incrementAttempts(id)`, and `resetAttempts(id)` remain exported, take only a bare `id`, and perform no tenant check at all — they rely entirely on the convention that "once a caller has an authorized job (via the scoped `getJob`), further mutation by id needs no repeated ownership check." That convention is exactly the "fetch-then-check" shape the plan itself cites as the OWASP-documented regression pattern, except here there's no `if` check even possible on these three functions — a future route or background job that calls `updateJob(req.params.id, ...)` without first calling the scoped `getJob` would silently mutate another tenant's job with zero structural resistance.

  <!-- dedup-key: section="key technical decisions risks dependencies" title="unscoped write primitives undercut the plans own centralized ownership check claim" evidence="u2s design leaves no unscoped variant exported from jobstore.ts the only unscoped fetch primitive is a private helper used" -->

- **API_KEYS boot validation doesn't reject non-object JSON shapes** — Implementation Units - U1 / Key Technical Decisions (P1, feasibility/security-lens/adversarial, confidence 100)

  The plan's stated guard is "if `API_KEYS` is unset, empty, or fails `JSON.parse`" — but `JSON.parse('null')`, `JSON.parse('[]')`, `JSON.parse('"x"')`, and `JSON.parse('42')` all succeed without throwing while producing a value that isn't a valid apiKey-\>tenantId object. If the implementation then does something like `Object.entries(parsed)` on that result, it throws a `TypeError` at module-load time (before `app.listen` ever runs), which is exactly the whole-process crash the plan explicitly designed to avoid. The plan never extends the same fail-closed reasoning to this class of input. Flagged independently by three reviewers.

  <!-- dedup-key: section="implementation units u1 key technical decisions" title="api_keys boot validation doesnt reject non object json shapes" evidence="if api_keys is unset empty or fails json.parse log a clearly distinguishable error line and fall back to an" -->

- **One malformed API_KEYS entry locks out every tenant, not just the bad one** — Key Technical Decisions (P2, feasibility/adversarial, confidence 100)

  The plan spends real effort justifying fail-closed-over-crash specifically to minimize blast radius from a bad config edit. But the actual mechanism chosen treats a single bad entry (an empty-string key or tenant id anywhere in the JSON blob) as a full parse failure, discarding the entire map — meaning a typo made while adding tenant #5 also revokes access for tenants #1-4, who were configured correctly. For a solo operator hand-editing a shared JSON blob for their own 2-5 projects, this is a realistic self-inflicted outage.

  <!-- dedup-key: section="key technical decisions" title="one malformed api_keys entry locks out every tenant not just the bad one" evidence="reject treat as a parse failure same fail closed path above any parsed entry with an empty string key or empty" -->

- **Undefined acceptance criteria (AE1/AE2) referenced throughout test scenarios** — Requirements Trace / Implementation Units U2 and U3 (P2, coherence, confidence 100)

  The test scenarios reference "AE1" and "AE2" as proof of requirement coverage, but these acceptance criteria are never defined in this plan document. Implementers following this plan won't know what AE1 and AE2 actually require without consulting the external origin document.

  <!-- dedup-key: section="requirements trace implementation units u2 and u3" title="undefined acceptance criteria ae1ae2 referenced throughout test scenarios" evidence="requirements trace states origin acceptance examples ae1 covers r6 r7 ae2 covers r5 but does not define what ae1" -->

- **U3's BullMQ keyspace test has no established pattern to implement it** — Implementation Units - U3 Test scenarios (P2, feasibility, confidence 75)

  Verifying that `removeOnComplete`/`removeOnFail` actually fires requires a real BullMQ Worker to process the job asynchronously and complete it, then polling until the Redis key disappears. No existing test file does this — `worker.test.ts` calls `processJob(job)` directly, bypassing BullMQ's own Worker/queue lifecycle entirely, and `webhooks.test.ts` never starts a worker or waits for async delivery.

  <!-- dedup-key: section="implementation units u3 test scenarios" title="u3s bullmq keyspace test has no established pattern to implement it" evidence="integration after a job completes delivery its record no longer persists in bullmqs own redis keyspace confirms removeoncompleteremoveonfail" -->

- **Malformed-API_KEYS boot log may leak all tenant secrets to logs** — Key Technical Decisions / Open Questions / U1 Approach (P2, security-lens, confidence 75)

  The plan specifies fail-closed behavior for a malformed `API_KEYS` value and repeatedly says to "log a clearly distinguishable error line" but never states the log must exclude the raw env var value. Since `API_KEYS` is a single JSON blob containing every tenant's plaintext API key, the most natural way an implementer makes a parse failure "discoverable" is to log the offending string, which would dump every configured tenant's bearer token into application logs.

  <!-- dedup-key: section="key technical decisions open questions u1 approach" title="malformed api_keys boot log may leak all tenant secrets to logs" evidence="fail closed not crash on a parse problem if api_keys is unset empty or fails json.parse log a clearly distinguishable" -->
