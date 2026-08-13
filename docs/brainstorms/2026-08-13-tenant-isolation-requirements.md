---
date: 2026-08-13
topic: tenant-isolation
---

# Tenant Isolation (Phase 1)

## Problem Frame

`distributed-webhook-dlq` currently has a single shared `API_KEY`. Every job is globally visible and replayable to anyone holding that key — `GET /webhooks?status=X` returns every job regardless of who created it, and `POST /webhooks/:id/replay` can replay any job by id. The user wants to point a handful of their own separate projects at this one shared service, but without isolation, a bug or compromise in one project's code could see or tamper with another project's webhook jobs.

Phase 0 (PR #7, not yet merged) already built the extension point for this: `resolveTenant(key)` in `src/auth/apiKey.ts` currently returns a hardcoded placeholder tenant (`{ id: "default" }`) on any valid key, and `req.tenant` is attached to every authenticated request but not yet read by anything downstream.

---

## Requirements

**Key provisioning**
- R1. The service supports multiple named tenants, each with its own API key, configured via a static config source (env var or small JSON file) loaded at startup — not a database or self-service API.
- R2. `resolveTenant` looks up the provided key against that static config and returns the matching tenant id, replacing the current hardcoded placeholder.
- R3. Adding, removing, or rotating a tenant's key is done by editing the static config and restarting the service. No admin endpoint or self-service flow.

**Data isolation**
- R4. Every job created records which tenant created it.
- R5. `GET /webhooks?status=X` only returns jobs belonging to the caller's own tenant.

**Access control**
- R6. `GET /webhooks/:id` returns `404` for a job that exists but belongs to a different tenant — indistinguishable from a truly nonexistent id.
- R7. `POST /webhooks/:id/replay` is scoped the same way: replaying a job belonging to a different tenant returns `404`.

**Behavior scope**
- R8. All tenants share the same global operational behavior (`MAX_ATTEMPTS`, the SSRF blocklist, backoff timing). No per-tenant configuration in this phase.

---

## Acceptance Examples

- AE1. **Covers R6, R7.** Given tenant A created job `evt_123`, when tenant B calls `GET /webhooks/evt_123` or `POST /webhooks/evt_123/replay` with tenant B's valid key, then the response is `404 {"error": "job not found"}` — identical to querying an id that was never created.
- AE2. **Covers R5.** Given tenant A has 3 jobs and tenant B has 5 jobs, when tenant A calls `GET /webhooks?status=QUEUED`, then only tenant A's matching jobs are returned, never tenant B's.

---

## Success Criteria

- The user can point a second (and third, fourth) project at this shared service and trust that a bug or compromise in one project's code can't see or touch another project's jobs.
- A future phase that adds self-service key provisioning or per-tenant configuration can do so without revisiting the isolation boundary itself — R4-R7 stay correct regardless of how keys eventually get provisioned.

---

## Scope Boundaries

- Self-service tenant/key provisioning (an endpoint or UI for creating/rotating keys) — not needed at this scale (2-5 known projects the user controls personally). Revisit if the consumer model changes to people outside the user's direct control.
- Per-tenant configuration (retry limits, allowed destination domains, etc.) — deferred; all tenants share global behavior for now (R8).
- Key rotation tooling beyond "edit config, restart."
- Tenant-level rate limiting or quotas — out of scope; rate limiting overall is a separate, not-yet-started phase from the earlier roadmap.
- Migrating or backfilling existing pre-Phase-1 jobs in Redis to a specific tenant — see Dependencies / Assumptions.

---

## Key Decisions

- **Static config over a Redis-backed key store**: the user knows all consumers personally (2-5 of their own projects) and doesn't need dynamic provisioning. Matches this project's existing `REDIS_HOST`/`REDIS_PORT`-style env var convention and its demonstrated preference for the simplest mechanism that solves the actual problem.
- **404 over 403 for cross-tenant access**: simpler mental model ("you only ever see your own jobs, full stop") and doesn't leak the existence of other tenants' job ids. It also means the tenant check can share the same code path as "does this job exist at all," rather than needing separate branching logic.
- **Isolation is data/access-only, not behavioral**: this phase answers "can tenant A see or touch tenant B's data," not "does tenant A get different treatment than tenant B." Keeps the phase tightly scoped; per-tenant behavior is a distinct, deferred concern (R8).

---

## Dependencies / Assumptions

- Builds directly on Phase 0 (PR #7: SSRF protection + API key auth), which must be merged first — `resolveTenant` and the fail-closed auth middleware this phase extends already exist there.
- Assumes existing pre-Phase-1 job data in Redis (created under the single shared key before this phase) doesn't need a migration path — it's acceptable for that data to become orphaned/inaccessible once tenant scoping is enforced, since this is a personal project with disposable test data. Revisit this assumption if there's real data worth preserving by the time this ships.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R4][Technical] Exact field name/shape for tenant ownership on `WebhookJob`, and whether `jobStore.ts`'s `getJobsByStatus` needs a tenant parameter added to its signature, or filtering happens at the route layer instead.
- [Affects R1][Technical] Exact config format (delimited env var vs. a small JSON file) and how it's parsed/validated at startup.

---

## Next Steps

-> `/ce-plan` for structured implementation planning
