---
title: "Phase 0: Security Hardening (SSRF Protection + API Key Auth)"
type: feat
status: active
date: 2026-08-08
deepened: 2026-08-08
---

# Phase 0: Security Hardening (SSRF Protection + API Key Auth)

## Overview

Before `distributed-webhook-dlq` is exposed beyond localhost or used by a second project, two gaps must close: (1) the worker makes an unrestricted server-side HTTP request to any caller-supplied `url`, which is a textbook SSRF vector, and (2) none of the API routes require any credential, so anyone who can reach the port can create arbitrary outbound jobs or read/replay any job. This plan hardens both, while deliberately keeping scope to exactly these two concerns — no multi-tenancy, no rate limiting, no payload signing (those are later phases).

---

## Problem Frame

`distributed-webhook-dlq` accepts a destination `url` via `POST /webhooks` and a background worker later performs `fetch(url, ...)` to deliver a JSON payload to it. Today:

- `url` is validated only via `new URL(url)` (`src/routes/webhooks.ts:16-21`), which accepts any scheme/host including `http://localhost`, private IPs, and cloud metadata endpoints (e.g. `169.254.169.254`).
- No route requires authentication — `src/index.ts` registers no middleware beyond `express.json()`.
- The system's own retry architecture makes this worse than a typical SSRF case: BullMQ retries happen minutes apart (`src/worker/worker.ts`, linear backoff up to `MAX_ATTEMPTS`), so a hostname validated as "safe" at creation time can resolve to a private IP by the time a retry actually connects (DNS rebinding), regardless of how careful the creation-time check is.

This plan closes both gaps with the minimum machinery needed to be genuinely safe, not a maximal security overhaul.

---

## Requirements Trace

- R1. No job may cause the worker to establish a connection to a private, loopback, link-local, or otherwise internal/reserved IP address, at any attempt (creation or any retry).
- R2. The SSRF check must be resistant to DNS rebinding — the IP validated must be the exact IP connected to, not a separately re-resolved one.
- R3. Every `/webhooks` route (`POST /webhooks`, `GET /webhooks/:id`, `GET /webhooks?status=`, `POST /webhooks/:id/replay`) must reject requests without a valid API key.
- R4. The auth implementation must not require a rewrite when this evolves from single-tenant (one shared key) to multi-tenant (per-project keys) in a later phase.
- R5. A job blocked by the SSRF guard must not consume retry attempts pointlessly — retrying against a destination that will never become valid wastes time and delays the fact that something suspicious happened.

---

## Scope Boundaries

- Multi-tenant API key storage (per-project keys, issuance/revocation) — only the seam is built now; the actual multi-tenant lookup is a later phase.
- Structured failure-reason / security audit logging on `WebhookJob` (e.g., a `lastError` field distinguishing "blocked by SSRF guard" from "destination unreachable") — deferred; Phase 0 uses existing `console.error` logging only, to avoid growing the data model for this phase.
- Rate limiting on job creation.
- Outbound payload signing (HMAC) so receivers can verify authenticity.
- DNS resolution caching or other performance optimization for the SSRF guard — acceptable overhead at current scale; revisit if it matters later. **Constraint on any future change here:** whatever optimization is eventually built must preserve per-connection re-validation inside the `connect` hook. Caching a resolved IP, or reusing a single dispatcher across different jobs/origins in a way that skips a fresh `connect`-time lookup per delivery attempt, would silently reopen the exact DNS-rebinding gap (R2) this design exists to close. This is the kind of thing that looks like a safe performance win and isn't.

### Deferred to Follow-Up Work

- Per-tenant API key issuance and Redis-backed key storage: later phase, once a second project actually needs to be onboarded (see prior roadmap discussion).

---

## Context & Research

### Relevant Code and Patterns

- `src/routes/webhooks.ts:8-40` — existing validation convention: inline per-field checks, `res.status(400).json({ error: "<message>" })`, early `return`. New checks should match this shape.
- `src/worker/worker.ts:13-19` — the actual outbound `fetch(job.url, ...)` call; this is the real security boundary (see Key Technical Decisions).
- `src/store/jobStore.ts` and `src/queue/queue.ts` — existing abstraction convention: a module constructs its own client internally and exports narrow plain functions; callers never touch the underlying client. New security modules should follow the same shape (e.g., a module exports `ssrfSafeFetch`, not the underlying `undici.Agent`).
- `src/redisConnection.ts:1-4` — existing env-var convention (`process.env.X ?? <default>` at module load, no config schema, no dotenv). Mirror this for the new `API_KEY` var.
- `package.json` — current deps are `express`, `bullmq`, `ioredis` (runtime), `tsx`/`typescript` (dev). No auth, validation, or IP-parsing libraries exist yet; no test framework or `test` script exists yet.

### Institutional Learnings

None — `docs/solutions/` does not exist in this repo yet. This phase is a strong candidate for `/ce-compound` afterward to start that directory (SSRF-guard approach and auth middleware pattern would be broadly reusable across future projects, which matches the user's stated multi-project goal).

### External References

- Node's built-in `fetch` runs on **undici** (bundled version 6.23.0 on Node 22.22.0), not `http.Agent` — popular SSRF-filtering libraries built for `http.Agent` (`request-filtering-agent`, `ssrf-req-filter`) do not work with native `fetch` and would silently pass it through unfiltered.
- undici's `Agent`/`Pool`/`Client` accept a `connect` option — a function invoked on *every* socket the dispatcher opens, including redirect targets. This is the correct integration point for DNS-pinned validation, since it naturally re-validates on redirect (undici/Node `fetch` follows redirects by default with no app-level re-validation hook otherwise).
- No built-in Node API classifies an IP as private/reserved (`net.isIP()` only validates format). `ipaddr.js` is the standard, actively-maintained library for CIDR/range classification.
- IP ranges commonly missed in hand-rolled SSRF guards: `169.254.0.0/16` (covers all major cloud metadata endpoints), IPv6 `::1`, `fc00::/7`, `fe80::/10`, IPv4-mapped IPv6 (`::ffff:0:0/96`, which bypasses IPv4-only range checks), CGNAT (`100.64.0.0/10`), and `0.0.0.0/8`. Also identified during plan review: IPv6 transition prefixes that embed an IPv4 address the same way `::ffff:` does — NAT64 (`64:ff9b::/96`), 6to4 (`2002::/16`), and Teredo (`2001::/32`). `ipaddr.js`'s built-in range classification does not decode these and re-check the embedded IPv4 the way it does for `::ffff:`; that decoding has to be done explicitly (see U2). This was weighed against the plan's own "minimum machinery, not a maximal overhaul" framing (Overview) — it's kept in scope because it's the same bypass family as the already-in-scope IPv4-mapped IPv6 case, just a different encoding, and the actual cost is a handful of pure decode functions plus tests, not new infrastructure.
- `crypto.timingSafeEqual` requires equal-length buffers (throws otherwise) — the standard safe pattern checks length first, then calls it, so a length mismatch fails closed without throwing. Critically, this does **not** cover the zero-length case: comparing two empty buffers returns `true` without throwing, which is a real bypass path if `API_KEY` is unset (see Key Technical Decisions).
- Classic SSRF bypasses via non-canonical IPv4 host literals (decimal `http://2130706433/`, octal `http://017700000001/`, hex `http://0x7f000001/`) are very likely already neutralized for free: the WHATWG URL Standard's IPv4-parsing algorithm, which both `new URL()` and undici's own URL handling implement, canonicalizes these forms to standard dotted-decimal before `.hostname` is ever read. This means `assertUrlAllowed`/`ssrfSafeFetch` see the canonical form as long as they extract the host via `new URL(url).hostname` (not a hand-rolled regex). This is a mechanism the plan is relying on, not one it built — it should be an explicitly asserted, tested behavior (see U2 test scenarios) rather than an unstated assumption that a future refactor (e.g., extracting the host via regex instead of the URL parser) could silently break.

---

## Key Technical Decisions

- **Validate at both creation time and delivery time, but treat delivery-time as the real security boundary.** Creation-time validation (in `routes/webhooks.ts`) gives fast feedback and rejects obviously-bad URLs before a job is even created. But because retries happen minutes apart, only a check performed at the moment of actual connection can be trusted — a hostname can flip from public to private between creation and a later retry. (Addresses R1, R2.)
- **Hand-roll the guard rather than adopting a third-party SSRF library.** The two most popular options (`request-filtering-agent`, `ssrf-req-filter`) are built for `http.Agent` and don't intercept native `fetch`/undici at all; a newer fetch-compatible option (`dssrf`) is single-maintainer and unproven. The actual mechanism (~50-100 lines: undici `Agent` with a custom `connect` hook, `dns.promises.lookup`, `ipaddr.js` range check) is small and fully within this project's existing "thin hand-rolled module" style.
- **Pin the connection to the exact validated IP inside the `connect` hook**, not via a separate pre-check before calling `fetch`. A pre-check-then-fetch pattern leaves a resolve/connect gap an attacker can exploit via DNS rebinding; validating inside `connect` closes it because that function fires for every socket the dispatcher opens, including redirect hops. (Addresses R2.)
- **The original hostname must be preserved as `servername` for TLS, even though the raw connection targets the pinned IP.** Overwriting the connector's `hostname` with the resolved IP without separately passing the original hostname as `servername` breaks SNI-based routing and certificate hostname verification for essentially every `https://` destination — which is the common case for real webhook receivers. This was caught during plan review (both the architecture and security passes independently flagged it) precisely because it's the kind of detail that "it connects to the validated IP" glosses over while looking complete. Getting this wrong risks a worse outcome than the bug being fixed: the natural "quick fix" for broken HTTPS delivery is disabling certificate verification, which reopens a MITM hole. (Addresses R1, R2 — see High-Level Technical Design.)
- **The `connect`-time validation logic (resolve hostname, classify every address, decide blocked/allowed) is named and shared as one function** (`resolveAndValidate`), used by both `assertUrlAllowed` (creation-time, inspects the result) and the `connect` hook inside `ssrfSafeFetch` (delivery-time, additionally uses the validated address to pin the connection). The IP-range classifier itself is a small pure function and easy to share correctly; the actual drift risk is in the resolution/iteration logic (DNS family handling, fail-open-vs-closed on resolution errors, "any blocked address blocks the whole result") — naming and centralizing that logic, not just the classifier, is what keeps the two call sites from diverging.
- **SSRF-blocked jobs skip the retry loop entirely and go straight to `DEAD_LETTER` on the first blocked attempt** — but the attempt still counts: `incrementAttempts` runs before `updateJob(job.id, DEAD_LETTER)`, exactly as it does on every other failure path, so `attempts` reads `1`, not `0` (see High-Level Technical Design and U3's test scenario, which was itself inconsistent with an earlier draft of the pseudocode until this was reconciled during review). Rather than having `worker.ts`'s catch block name the SSRF guard's concrete error type directly (`instanceof SsrfBlockedError`, which would require `worker.ts` to import `security/ssrfGuard.ts`), the guard's error extends a small shared `NonRetryableError` marker living in the neutral `src/errors.ts`, and the catch block checks `instanceof NonRetryableError`. **The justification for this one level of indirection is dependency direction, not speculative extensibility** — the goal is keeping `worker.ts` (a general delivery mechanism) from depending on `security/ssrfGuard.ts` (one specific policy module), not anticipating future error types that don't exist yet. If a second non-retryable condition never materializes, this is still the right shape; it isn't premature generalization for its own sake. Retrying a destination that's blocked by policy will never succeed — burning attempts on it only delays visibility into what's actually a policy violation, not a flaky destination. (Addresses R5.)
- **Auth middleware is registered inside `webhooksRouter` itself** (`webhooksRouter.use(...)`, before route definitions), not at the `index.ts` mount call site. This makes the router self-protecting — the guarantee "no route under `/webhooks` can ship unprotected" is structural (travels with the router wherever it's mounted) rather than depending on whoever wires up `index.ts` remembering to wrap it correctly. `/health` remains intentionally unauthenticated (standard practice for infrastructure health checks) since it's mounted directly on `app`, not on `webhooksRouter`.
- **The auth seam is a single `resolveTenant(key)`-shaped function, with zero Express coupling** — its signature is `(key: string) => { id: string } | null`, importing no `express` types. Only the middleware wrapper touches `req`/`res`/`next`. Today `resolveTenant` does one `timingSafeEqual` check against `process.env.API_KEY` and returns a placeholder tenant; swapping in a Redis-backed per-tenant lookup later changes only this function's body, and the zero-coupling constraint means it stays reusable outside an HTTP request context too (e.g. a future admin CLI). `req.tenant` is attached from day one (even as `{ id: "default" }`) so downstream code never needs a signature change to become tenant-aware. (Addresses R3, R4.)
- **`API_KEY` must have no default value and must fail closed if unset — it does not follow the `redisConnection.ts` `process.env.X ?? <default>` convention.** That convention is safe for `REDIS_HOST`/`REDIS_PORT` because a sane default exists; applied to a secret, a default (or a silently-missing env var treated as "no auth required") is exactly the kind of misconfiguration that fails open instead of closed. This matters concretely because of a specific edge case: `crypto.timingSafeEqual` does not throw when comparing two zero-length buffers — it returns `true`. If `API_KEY` is unset (empty) and a caller sends `Authorization: Bearer ` (empty token), a naive length-check-then-`timingSafeEqual` implementation would authenticate successfully. The middleware must treat an unset/empty configured key as an unconditional rejection, checked before any comparison logic runs, not as an emergent property of the comparison. (Addresses R3.)
- **The undici `Agent`/dispatcher is constructed once at module load, as a singleton — matching the existing `queue.ts`/`jobStore.ts` convention** of constructing a client once and exporting functions that reuse it — rather than building a new `Agent` per delivery attempt. The `connect` hook closes over no per-request state that isn't already passed to it via `connectOpts`, so there's no correctness reason for per-call construction, and a fresh `Agent` (fresh connection pool) per attempt would forgo keep-alive reuse and add needless allocation on a path already flagged as latency-sensitive.
- **New test coverage uses Node's built-in `node:test` + `node:assert`, not a new framework dependency** (Vitest/Jest). This is the first test infrastructure in the repo; given the project's consistent preference for minimal dependencies throughout its history, and that Node 22 ships a capable built-in runner, adding a new framework isn't justified for this phase's scope.
- **New runtime dependency: `ipaddr.js`.** No built-in Node API classifies IP ranges; this is the standard, actively-maintained library for it.
- **New runtime dependency: `undici`, pinned to `^6.23.0` — not left implicit.** Verified directly during plan review: neither `node:undici` nor bare `undici` is importable without adding it as an explicit dependency, and installing it unpinned resolves to whatever is currently `latest` (v8.x at time of writing). Passing a v8 `Agent` as `dispatcher` to Node 22's native `fetch` — which bundles undici v6.23.0 internally — throws `InvalidArgumentError` on every single request, not just SSRF-blocked ones; this was reproduced directly. The pinned major version must track whatever undici version the target Node runtime bundles (currently v6.x on Node 22), and a future Node upgrade that bumps its internal undici major requires re-checking this pin, not just a routine dependency bump.
- **DNS resolution failures inside `resolveAndValidate` are a distinct outcome from "blocked" and must not throw `NonRetryableError`.** A hostname that fails to resolve at all (`ENOTFOUND`) or times out is an ordinary destination-is-unreachable failure — it should flow into the existing `RETRYING`/backoff path like any other connection failure, not be treated as a policy violation. Conflating "couldn't resolve" with "resolved to something blocked" would silently misclassify ordinary flaky-DNS failures as permanent dead-letters. (See High-Level Technical Design and U2 test scenarios.)

---

## Open Questions

### Resolved During Planning

- Where should the SSRF check live (creation vs. delivery vs. both)?: Both, with delivery-time as the actual security boundary (see Key Technical Decisions).
- Should an SSRF-blocked job retry?: No — straight to `DEAD_LETTER` on first blocked attempt, via a distinguishable error type.
- Which library for IP range classification?: `ipaddr.js`.
- Which library/approach for the fetch-level guard?: Hand-rolled undici `Agent` with a custom `connect` hook — no existing library correctly intercepts native `fetch`.
- Auth header scheme?: `Authorization: Bearer <key>`, matching common convention.
- Test framework?: Node's built-in `node:test`, no new dependency.

### Resolved During Plan Review (Deepening Pass)

- Should the IP-pinning connector preserve the original hostname for TLS?: Yes — as `servername`, passed alongside the pinned IP. Missing this would break SNI/certificate verification for essentially every HTTPS destination; caught independently by both the architecture and security review passes.
- Should `worker.ts` check for the SSRF guard's concrete error type by name?: No — the guard's error extends a shared `NonRetryableError` base in `src/errors.ts`, and `worker.ts` checks that generic type, decoupling it from the security module's specifics. (Justification tightened in a later review pass — see below.)
- Should `API_KEY` follow the existing `?? <default>` env-var convention?: No — it must have no default and fail closed if unset, to avoid a `timingSafeEqual`-zero-length-buffer bypass.
- Where should auth middleware be mounted?: Inside `webhooksRouter` itself (`webhooksRouter.use(...)`), not at the `index.ts` call site — makes the router self-protecting structurally rather than by convention.

### Resolved During Document Review (Second Pass)

- Is `undici` actually available as `node:undici` or needs no dependency entry?: No — it must be added as an explicit `package.json` dependency, pinned to `^6.23.0` to match Node 22's internally-bundled undici major. Verified directly that an unpinned install resolves to an incompatible major (v8.x) and breaks every delivery, not just SSRF-blocked ones.
- Is `NonRetryableError`'s justification "future non-retryable error types might come later"?: No, that framing was unsupported speculation and has been corrected — the actual justification is dependency direction (`worker.ts` shouldn't import `security/ssrfGuard.ts` directly), which holds regardless of whether a second non-retryable error type is ever added.
- Does `attempts` increment for an SSRF-blocked job?: Yes — `incrementAttempts` runs unconditionally before the retry/no-retry branch, same as every other failure path. (This was an internal inconsistency between the original pseudocode and U3's test scenario, caught during document review and reconciled.)
- How should a DNS resolution failure (unresolvable hostname, timeout) be classified?: As an ordinary retryable failure, explicitly distinct from `NonRetryableError`/blocked — the pseudocode and test scenarios were updated to make this an asserted behavior rather than an unstated gap.
- Should the SSRF-rejection error message include the resolved IP or matched rule?: No — it must be generic, to avoid handing an authenticated caller a low-cost oracle for probing internal network reachability.

### Deferred to Implementation

- The exact enumerated CIDR/prefix list is now specified in Context & Research and U2's test scenarios (RFC1918, loopback, link-local/cloud-metadata, IPv6 ULA/link-local, IPv4-mapped IPv6, NAT64/6to4/Teredo, CGNAT, `0.0.0.0/8`, decimal/octal/hex IPv4 literals) — implementation should still double-check this list against `ipaddr.js`'s actual behavior for each case, since some (like the transition prefixes) require explicit decoding logic `ipaddr.js` doesn't provide out of the box.

---

## Output Structure

    src/
      errors.ts              # shared NonRetryableError marker
      security/
        ssrfGuard.ts
        ssrfGuard.test.ts
      auth/
        apiKey.ts
        apiKey.test.ts
    .env.example

---

## High-Level Technical Design

> This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.

The core mechanism — validation happening inside the dispatcher's connection hook, so it re-runs on every socket including redirects. Note that the resolved IP is used only as the low-level connect target; the original hostname is preserved separately for TLS (`servername`), since that's what SNI-based routing and certificate hostname verification depend on — pinning the raw connection to an IP does not mean the TLS layer should ever see that IP in place of the real hostname:

```
resolveAndValidate(hostname):
    # shared by assertUrlAllowed (creation-time) and the connect hook below (delivery-time)
    try:
        addresses = dns resolve `hostname`, all address families, with a bounded timeout
    catch (dnsError):
        # unresolvable/timed-out is "destination unreachable", NOT "blocked" —
        # this must surface as a normal failure, not a policy violation
        throw dnsError    # propagates as an ordinary retryable error, unchanged from today
    decode any NAT64 / 6to4 / Teredo embedded-IPv4 addresses before classifying
    blocked = any(address is private/loopback/link-local/reserved, for address in addresses)
    return { blocked, addresses }

ssrfSafeFetch(url, options):
    # dispatcher constructed once, at module load — not per call
    dispatcher = moduleScopedAgent   # Agent({ connect(connectOpts, callback): ... })

    # inside that Agent's connect hook:
    connect(connectOpts, callback):
        result = resolveAndValidate(connectOpts.hostname)   # a dnsError here propagates via callback(dnsError), not as SsrfBlockedError
        if result.blocked:
          callback(new SsrfBlockedError(...))    # never opens the socket
          return
        defaultConnector(
          { ...connectOpts, hostname: result.addresses[0], servername: connectOpts.hostname },
          callback
        )

    return fetch(url, { ...options, dispatcher })
```

Because `connect` fires for every new socket the dispatcher opens — including a socket opened for a redirect target at a different origin — this closes the redirect-based bypass without any separate redirect-handling code.

`SsrfBlockedError` extends a small shared `NonRetryableError` marker living in `src/errors.ts` (not caught by name in `worker.ts` — see below). The point of this one level of indirection is dependency direction (`worker.ts` depends on the neutral `src/errors.ts`, not on `security/ssrfGuard.ts` specifically), not anticipated future error types — see Key Technical Decisions.

In the worker's failure handling, the error's general "is this retryable" identity — not its specific concrete type — changes the branch taken. Note that the attempt still counts either way; only the retry decision differs:

```
catch (error):
    attempts = incrementAttempts(job.id)   # unconditional — a blocked attempt is still an attempt
    if error is a NonRetryableError:
        updateJob(job.id, DEAD_LETTER)   # no retry, regardless of MAX_ATTEMPTS
    else:
        # existing attempts < MAX_ATTEMPTS retry/backoff logic, unchanged
```

---

## Implementation Units

- [x] U1. **Add minimal test infrastructure**

**Goal:** Enable automated tests for the security-critical logic this phase introduces, without adding a new test framework dependency.

**Requirements:** Supports verification of R1-R5.

**Dependencies:** None.

**Files:**
- Modify: `package.json` (add a `test` script using Node's built-in `--test` runner against `tsx`-transpiled TypeScript test files)

**Approach:**
- Use Node 22's built-in `node:test` + `node:assert/strict` — zero new dependencies, consistent with the project's minimal-dependency history.
- Convention: `*.test.ts` colocated next to the file it tests (see Output Structure).

**Test scenarios:**
- Test expectation: none — this unit is infrastructure only; it's verified by the first real test file in U2 running successfully.

**Verification:**
- Running the new `test` script executes and reports pass/fail for a trivial placeholder test.

---

- [x] U2. **SSRF guard core module**

**Goal:** Build the core security primitive: a DNS-pinned, redirect-safe `fetch` replacement, plus a standalone hostname/URL check usable for fast creation-time feedback.

**Requirements:** R1, R2, R5.

**Dependencies:** U1 (test infra).

**Files:**
- Create: `src/errors.ts` (shared `NonRetryableError` marker/base class)
- Create: `src/security/ssrfGuard.ts`
- Test: `src/security/ssrfGuard.test.ts`
- Modify: `package.json` (add `ipaddr.js` and `undici` — pinned `^6.23.0` to match Node 22's internally-bundled undici major; see Key Technical Decisions for why this must be explicit and pinned, not left to resolve to `latest`)

**Approach:**
- `src/errors.ts` exports `NonRetryableError`, a small base class (or equivalent marker) with no dependency on the security module — it's a general worker-level concept, not SSRF-specific, so it doesn't belong inside `ssrfGuard.ts`.
- `ssrfGuard.ts` exports `SsrfBlockedError extends NonRetryableError`, distinguishable from generic fetch failures.
- Export a single shared `resolveAndValidate(hostname)` function that resolves via `dns.promises.lookup(..., { all: true })`, decodes any NAT64 (`64:ff9b::/96`)/6to4 (`2002::/16`)/Teredo (`2001::/32`) embedded IPv4 addresses before classifying, and classifies every resolved address with `ipaddr.js` against the blocked-range list (see Context & Research). This is the single source of truth both other functions build on — see High-Level Technical Design. **A DNS resolution failure (unresolvable hostname, timeout) is not the same outcome as "blocked"** — it must propagate as an ordinary error, not `NonRetryableError`, so it falls into the existing retryable path rather than being misclassified as a policy violation.
- Export `ssrfSafeFetch(url, options)`: a **module-scope singleton** undici `Agent` (constructed once at load, matching `queue.ts`/`jobStore.ts` convention — not rebuilt per call) whose `connect` hook calls `resolveAndValidate` with a bounded timeout (a hung DNS lookup must not stall the socket indefinitely), rejects via the callback (never opening a socket) if blocked, and otherwise connects to the validated IP while passing the **original hostname as `servername`** so TLS SNI and certificate hostname verification still target the real host, not the IP. Passed as `dispatcher` to the underlying `fetch` call.
- Export a lighter-weight `assertUrlAllowed(url)` for creation-time use — calls `resolveAndValidate` directly and returns/throws based on the `blocked` flag, without wiring up a dispatcher, for a fast 400 response before a job is ever created. **Its rejection message must be generic (e.g. "destination not allowed") and must not echo the resolved IP address(es) or which specific range/rule triggered the block** — an authenticated caller probing which internal hosts are reachable is a real, if narrow, information-disclosure surface that a detailed error message would hand them for free. Reserve resolution detail for server-side logs only.
- Extract the hostname via `new URL(url).hostname` (never a hand-rolled regex) — this is what makes the WHATWG URL parser's IPv4 canonicalization (see Context & Research) actually apply.

**Technical design:** See High-Level Technical Design above.

**Patterns to follow:**
- `src/queue/queue.ts` / `src/store/jobStore.ts` — construct internals privately (and once, at module load), export narrow plain functions.

**Test scenarios:**
- Happy path: a hostname resolving only to a public IP is allowed.
- Happy path: `ssrfSafeFetch` against a real HTTPS destination with a valid certificate succeeds — proves IP-pinning did not break SNI/certificate hostname verification (this is the scenario that would have caught the SNI gap found during plan review).
- Edge case: RFC1918 ranges (`10.x`, `172.16-31.x`, `192.168.x`) are blocked.
- Edge case: loopback (`127.0.0.1`, `::1`) is blocked.
- Edge case: link-local including cloud metadata (`169.254.169.254`) is blocked.
- Edge case: IPv6 unique-local (`fc00::/7`) and link-local (`fe80::/10`) are blocked.
- Edge case: IPv4-mapped IPv6 (`::ffff:10.0.0.1`) is blocked (commonly missed by naive IPv4-only checks).
- Edge case: NAT64 (`64:ff9b::10.0.0.1`), 6to4 (`2002::`), and Teredo (`2001::`) prefixes with an embedded private IPv4 address are blocked (requires explicit decoding, not just opaque IPv6 range classification).
- Edge case: CGNAT (`100.64.0.0/10`) and `0.0.0.0/8` are blocked.
- Edge case: decimal (`http://2130706433/`), octal (`http://017700000001/`), and hex (`http://0x7f000001/`) encodings of `127.0.0.1` are blocked — makes explicit and regression-proof a behavior the plan currently relies on WHATWG URL canonicalization to provide "for free."
- Error path: a hostname that resolves to multiple IPs where at least one is blocked is rejected entirely (fail closed, not "allow if any address is public").
- Error path: a hostname that fails to resolve at all (e.g. NXDOMAIN) rejects with an ordinary error, and specifically **not** `SsrfBlockedError`/`NonRetryableError` — proves DNS failure and policy-block are kept distinct, at both `assertUrlAllowed` and `ssrfSafeFetch`.
- Integration: `ssrfSafeFetch` against a local test server that issues a redirect to a blocked address rejects the request (proves the `connect` hook, not just a pre-check, is doing the work).
- Integration: rejection surfaces as `SsrfBlockedError`, and `error instanceof NonRetryableError` is true — proves the generalized type hierarchy `worker.ts` will depend on (U3) actually holds.
- Error path: `assertUrlAllowed`'s rejection for a blocked URL does not include the resolved IP address or matched range/rule in its message (information-disclosure check).

**Verification:**
- All test scenarios above pass under `npm test`.
- Manually confirmed: `ssrfSafeFetch` against `http://169.254.169.254/` rejects without making a network call.
- Manually confirmed: `ssrfSafeFetch` against a real `https://` URL (e.g. a webhook.site endpoint) succeeds without a certificate error.

---

- [x] U3. **Wire SSRF guard into job creation and worker delivery**

**Goal:** Integrate U2 at both call sites so no job can ever cause a request to a blocked destination, and blocked jobs don't waste retries.

**Requirements:** R1, R2, R5.

**Dependencies:** U2.

**Files:**
- Modify: `src/routes/webhooks.ts` (creation-time check)
- Modify: `src/worker/worker.ts` (delivery-time check, retry-skip branch)
- Test: extend or add tests covering the integration points (e.g. `src/routes/webhooks.test.ts`, `src/worker/worker.test.ts`)

**Approach:**
- In `routes/webhooks.ts`, call the creation-time check alongside the existing `url`/`payload` validation (same `400` + `{ error }` shape as existing checks) — reject before `createJob`/`enqueue` are ever called.
- In `worker.ts`, replace the direct `fetch(job.url, ...)` call with `ssrfSafeFetch(job.url, ...)`.
- In `processJob`'s `catch` block, `incrementAttempts` still runs unconditionally as it does today (a blocked attempt still counts as an attempt), then check `error instanceof NonRetryableError` (the shared base from `src/errors.ts`, not the SSRF guard's concrete `SsrfBlockedError` type) — if true, call `updateJob(job.id, DEAD_LETTER)` directly, bypassing the existing `attempts < MAX_ATTEMPTS` branch entirely. If the caught error is an ordinary DNS resolution failure (not `NonRetryableError`), it falls through to the existing retry logic unchanged. This keeps `worker.ts` decoupled from `security/ssrfGuard.ts`'s specifics (see Key Technical Decisions and High-Level Technical Design).

**Patterns to follow:**
- Existing validation block structure in `src/routes/webhooks.ts:11-26`.
- Existing `try/catch` structure in `src/worker/worker.ts` `processJob`.

**Test scenarios:**
- Happy path: `POST /webhooks` with a URL resolving to a public IP behaves exactly as before (regression).
- Error path: `POST /webhooks` with a URL resolving to a private/loopback/link-local IP returns `400` and no job is created (verify no key appears in the store for it).
- Integration: a job whose URL passes creation-time validation but is later found to resolve to a blocked IP at delivery time (simulate via DNS rebinding or a directly-crafted job) goes straight to `DEAD_LETTER` on the very first worker attempt, with `attempts` reflecting a single attempt (`1`), not `0` and not `MAX_ATTEMPTS`.
- Regression: a job that fails delivery for an ordinary reason (e.g. connection refused, non-2xx response, or an unresolvable hostname) still goes through the existing `RETRYING` → `DEAD_LETTER` cycle unchanged — confirms DNS resolution failures are not misclassified as SSRF blocks.
- Error path: the `400` response body for a blocked `url` is a generic message, not the resolved IP or matched rule (information-disclosure check, matches U2's equivalent scenario).

**Verification:**
- All test scenarios above pass.
- Manually confirmed via the existing curl-based workflow: a request with `url` pointed at `http://169.254.169.254/` is rejected at creation with `400`.

---

- [x] U4. **API key authentication middleware**

**Goal:** Require a valid API key on every `/webhooks` route, structured so it can evolve into per-tenant keys later without a rewrite.

**Requirements:** R3, R4.

**Dependencies:** U1 (test infra); independent of U2/U3.

**Files:**
- Create: `src/auth/apiKey.ts`
- Test: `src/auth/apiKey.test.ts`
- Modify: `src/routes/webhooks.ts` (register `webhooksRouter.use(...)` before the route definitions — this is the only mounting point; not `src/index.ts`)

**Approach:**
- Middleware reads `Authorization: Bearer <key>` header; missing/malformed header is an immediate `401` with the existing `{ error }` shape.
- **`API_KEY` has no default value and does not follow the `redisConnection.ts` `process.env.X ?? <default>` convention.** If `API_KEY` is unset or empty, every request must be unconditionally rejected — checked as its own condition before any key comparison runs, not left as an emergent property of the comparison logic. This matters concretely: `crypto.timingSafeEqual` does not throw when comparing two zero-length buffers, it returns `true` — so an unset `API_KEY` plus a request with an empty Bearer token (`Authorization: Bearer `) would otherwise authenticate successfully.
- Compare the provided key against `process.env.API_KEY` using length check + `crypto.timingSafeEqual`, never a plain `===` (timing-attack resistance) — this comparison only runs once the fail-closed check above has confirmed a real key is configured.
- Export `resolveTenant(key: string): { id: string } | null` as the actual lookup, with **no dependency on `express` types** — only the middleware wrapper touches `req`/`res`/`next`. Today's implementation is the single-key comparison above, returning a placeholder tenant (e.g. `{ id: "default" }`) on success. Middleware calls this function and attaches the result to `req.tenant`; swapping in a Redis-backed per-tenant lookup later means changing only this function's body, and the zero-coupling constraint keeps it usable outside an HTTP context too.
- Apply via `webhooksRouter.use(...)` inside `src/routes/webhooks.ts`, before its route definitions — this makes the router self-protecting regardless of how/where it's mounted in `index.ts`, rather than relying on the mount call site to remember to wrap it. `/health` in `src/index.ts` is mounted directly on `app`, not on `webhooksRouter`, and remains unauthenticated.

**Patterns to follow:**
- Existing error response shape: `res.status(...).json({ error: "..." })`.
- `src/redisConnection.ts` env-var reading style — but see the fail-closed constraint above; `API_KEY` deliberately does **not** mirror its `?? <default>` pattern.

**Test scenarios:**
- Happy path: request with the correct key in `Authorization: Bearer <key>` proceeds, and `req.tenant` is populated.
- Error path: missing `Authorization` header → `401`.
- Error path: malformed header (wrong scheme, empty key) → `401`.
- Error path: incorrect key → `401`.
- Edge case: provided key of different length than the expected key → `401`, without throwing (verifies the length-guard before `timingSafeEqual`).
- Edge case: `API_KEY` unset/empty → every request rejected, including a request carrying an empty Bearer token (`Authorization: Bearer `) — proves the fail-closed check runs independently of the length+`timingSafeEqual` comparison, not as a side effect of it.
- Regression: `GET /health` remains accessible with no `Authorization` header.

**Verification:**
- All test scenarios above pass, including the `API_KEY`-unset fail-closed case specifically (this is the one most worth double-checking manually, not just trusting the test).
- Manually confirmed: existing curl workflow against `/webhooks` now requires the header; a request without it returns `401`.

---

- [x] U5. **Environment/config documentation**

**Goal:** Document the new `API_KEY` requirement and SSRF guard behavior so the existing manual-testing workflow (and any future consumer) knows how to configure and understand this phase's changes.

**Requirements:** Supports R3, R4 (usability of the auth requirement).

**Dependencies:** U2, U3, U4.

**Files:**
- Create: `.env.example`
- Modify: `README.md`

**Approach:**
- `.env.example` documents `API_KEY` (with a generation example, e.g. `openssl rand -hex 32` — since there's no rate limiting in this phase, a short or guessable key defeats the point of timing-safe comparison entirely), `REDIS_HOST`, `REDIS_PORT` (the latter two already exist but are undocumented).
- README gains a short "Security" section: the auth requirement (how to set `API_KEY`, how to send it), and a brief note on what the SSRF guard blocks and why (so a future maintainer — including a future you — understands why `http://localhost` destinations no longer work for testing, and that `webhook.site`-style public URLs are the correct way to test locally now).

**Test scenarios:**
- Test expectation: none — documentation only.

**Verification:**
- A new reader following the README can correctly set `API_KEY` and make an authenticated request on the first try.

---

## System-Wide Impact

- **Interaction graph:** `src/worker/worker.ts` and `src/routes/webhooks.ts` both gain a dependency on the new `src/security/ssrfGuard.ts`. `src/index.ts` and/or `src/routes/webhooks.ts` gain a dependency on the new `src/auth/apiKey.ts`. No existing module's public function signatures change (`enqueue`/`onJob`/`createJob`/etc. are untouched).
- **Error propagation:** The SSRF guard's error type must propagate distinctly through `processJob`'s `catch` block — a regression here (e.g. wrapping/losing the error type) would silently revert blocked jobs to the normal retry path, defeating R5.
- **API surface parity:** All four `/webhooks` routes must end up behind the auth middleware — because it's applied at the router level rather than per-route, no route should be individually exempt except `/health`. Explicitly verify the `replay` route (easy to forget since it was added most recently) is covered.
- **Integration coverage:** The full path from `POST /webhooks` (creation-time check) through to worker delivery (delivery-time check) involves two independent enforcement points; unit tests on `ssrfGuard.ts` alone don't prove the wiring in `routes/webhooks.ts` and `worker.ts` is correct — U3's integration-style test scenarios are what actually prove the end-to-end guarantee in R1.
- **Unchanged invariants:** `WebhookJob`'s shape, `JobStatus` enum values, retry/backoff timing for ordinary failures, and the existing `GET /webhooks/:id` / `GET /webhooks?status=` response formats are all unchanged by this phase — only reachability (now requires auth) and one new rejection path (SSRF-blocked → straight to `DEAD_LETTER`) are added.
- **Interaction with the existing replay feature:** `POST /webhooks/:id/replay` re-enqueues a `DEAD_LETTER` job with no re-validation of `job.url` and no way to distinguish "blocked by the SSRF guard, will be blocked again" from "flaky destination, worth retrying" — Scope Boundaries already defers structured failure-reason tracking, so this phase has no `lastError` field to consult. Delivery-time `ssrfSafeFetch` will still catch a replayed SSRF-blocked job on its next attempt (no security hole — defense in depth holds), but an operator can end up replaying a permanently-blocked job repeatedly with no signal explaining why. This is a deliberate, documented trade-off for this phase, not a silently emergent one. **This "defense in depth holds" claim depends on an invariant this plan doesn't enforce mechanically: `ssrfSafeFetch` must remain the codebase's only outbound-request path.** Nothing prevents a future feature from adding a raw `fetch()` call elsewhere that bypasses the guard while this reasoning is still assumed to hold. Not worth building an enforcement mechanism (e.g. a lint rule) for at Phase 0's scale, but worth remembering as an assumption, not a guarantee, the next time a new outbound HTTP call is added anywhere in this codebase.
- **Whether `POST /webhooks/:id/replay` should re-run `assertUrlAllowed` before re-enqueueing** (surfacing a still-blocked destination as an immediate `400` instead of a delayed one-attempt dead-letter cycle) is left as an open question rather than a requirement of this phase — the delivery-time check already provides the actual security guarantee either way, so this is a UX refinement, not a gap. Worth revisiting if replaying known-blocked jobs turns out to be a common annoyance in practice.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Hand-rolled SSRF guard has a subtle bypass (missed IP range, IPv6 edge case, IP-obfuscation encoding) | U2's test scenarios explicitly cover the ranges and encodings most commonly missed in hand-rolled guards (IPv4-mapped IPv6, NAT64/6to4/Teredo, CGNAT, cloud metadata, decimal/octal/hex IPv4 literals), sourced directly from research rather than an ad hoc list |
| Pinning the connection to a raw IP breaks TLS SNI/certificate verification for HTTPS destinations if the original hostname isn't separately preserved as `servername` | Called out explicitly in Key Technical Decisions and the High-Level Technical Design pseudocode; U2 requires a real-HTTPS-destination test scenario specifically to catch a regression here, since the more obvious redirect/plain-HTTP tests wouldn't |
| undici's `connect`-hook API is not officially documented as a stable public extension point and could change in a future Node/undici version | Note the Node/undici version this was built against in a code comment in `ssrfGuard.ts`; U2's redirect-based integration test would fail loudly if the hook stops firing |
| **Deploy ordering:** the API and worker are independently restarted long-running processes; the worker is the actual security boundary (per Key Technical Decisions), so if the new auth-gated API ships while the old, unguarded worker is still running, any job already sitting in Redis from before rollout still gets delivered through the old, un-guarded `fetch` | Restart the worker process first (or simultaneously with the API) when deploying this phase; treat a state where only one process has been updated as still-exposed, not partially secured — worth a manual check immediately after rollout, not just at the end of a longer deploy sequence |
| `worker.ts`'s retry scheduling uses an in-memory `setTimeout`, not a persisted BullMQ delayed job — restarting the worker process (required to deploy the SSRF guard) silently drops any job currently `RETRYING` and waiting on that timer; it never gets re-enqueued and never reaches `DEAD_LETTER` either, it just stalls forever | Pre-existing behavior, surfaced now because this phase forces a worker restart. Check for jobs stuck in `RETRYING` after the rollout restart (`GET /webhooks?status=RETRYING`) and manually replay them if needed. Migrating retry scheduling to BullMQ's own delayed-job mechanism would fix this properly but is out of scope for Phase 0 — worth flagging as a forward-reference for a later phase |
| New `API_KEY` requirement breaks the existing curl-based manual-testing habit built up over this whole project | U5 documents the new header requirement clearly; it's a single env var, not a new system to learn |
| DNS resolution on every delivery attempt (including each retry) adds latency/load | Acceptable at current scale (personal project, low volume); explicitly deferred as a non-goal (see Scope Boundaries), with an explicit constraint that any future caching optimization must not skip per-connection re-validation |
| An authenticated caller can distinguish "blocked by policy" from "genuinely down" by observing status transitions: a blocked job jumps straight to `DEAD_LETTER` after one attempt, while a flaky-but-legitimate destination goes through the full `RETRYING` backoff cycle first — a low-cost internal-network reconnaissance signal for anyone holding the API key | Accepted trade-off for Phase 0: the alternative (retrying blocked destinations through the full cycle to hide the distinction) directly conflicts with R5's goal of fast visibility into policy violations. Worth revisiting if/when this evolves to multi-tenant (R4), since job visibility would then potentially span less-trusted parties |
| The hand-rolled SSRF guard is the only layer of defense — a bug in it is a full bypass, since nothing else in this plan constrains outbound requests | Complementary infra-level egress filtering (e.g. a cloud security group or firewall rule blocking outbound access to `169.254.169.254` and RFC1918 ranges) is a standard, typically low-cost fail-safe for exactly this failure mode. Out of scope for this plan (it's infrastructure, not application code), but worth doing alongside this phase wherever the service is actually deployed |
| **Found during code review, post-implementation:** the DNS timeout in `resolveAndValidate` bounds only how long a *caller* waits, not the underlying `dns.promises.lookup()` call — Node's `dns/promises` has no cancellation, so a timed-out lookup keeps occupying a libuv threadpool slot (default 4) until it resolves on its own. A handful of concurrent slow/black-holed-DNS destinations (an authenticated caller registering ordinary-looking webhooks, not necessarily malicious) can exhaust the threadpool and stall unrelated DNS work app-wide. Independently flagged by two reviewers (reliability, adversarial). | Accepted for Phase 0 (no rate limiting exists yet, so this is one of several load-based risks that share the same eventual fix); documented in a code comment at `withTimeout` in `ssrfGuard.ts`. Worth addressing (a concurrency cap on in-flight lookups, or switching to `dns.resolve4`/`resolve6`) alongside rate limiting in a later phase, not as a standalone fix now |
| **Found during code review, post-implementation:** two P0 bugs were caught only by code review, not by planning or implementation: (1) a DNS resolution failure at creation time was re-thrown out of an async Express handler with no global error handler, crashing the whole process on an ordinary hostname typo; (2) IPv6 `::` (the exact analog of the already-blocked IPv4 `0.0.0.0`) was missing from `BLOCKED_IPV6_RANGES`, a real SSRF bypass, empirically reproduced by the reviewer. | Both fixed and covered by regression tests before merge (see commits `cef168e` and the `BLOCKED_IPV6_RANGES` fix). Noted here as a reminder that even a plan through two adversarial review passes still needs a full code-review pass against the actual implementation — design-level review and implementation-level review catch different classes of bugs |

---

## Documentation / Operational Notes

- README gains a "Security" section per U5.
- Consider `/ce-compound` after this phase lands — the SSRF guard and auth-middleware seam are exactly the kind of reusable pattern worth capturing in `docs/solutions/` for the user's stated goal of using this across multiple projects.

---

## Sources & References

- [undici Client.md (v6.x)](https://raw.githubusercontent.com/nodejs/undici/v6.x/docs/docs/api/Client.md)
- [undici Connector.md (v6.x)](https://raw.githubusercontent.com/nodejs/undici/v6.x/docs/docs/api/Connector.md)
- [nodejs/undici#2019 — no way to plug anti-SSRF logic](https://github.com/nodejs/undici/issues/2019)
- [nodejs/undici#421 — custom lookup option](https://github.com/nodejs/undici/issues/421)
- [request-filtering-agent — GitHub](https://github.com/azu/request-filtering-agent)
- [OWASP SSRF Prevention in Node.js](https://owasp.org/www-community/pages/controls/SSRF_Prevention_in_Nodejs)
- [ipaddr.js — npm](https://www.npmjs.com/package/ipaddr.js)
- [WHATWG URL Standard — IPv4 parsing algorithm](https://url.spec.whatwg.org/#concept-ipv4-parser) — the mechanism relied on to neutralize decimal/octal/hex IPv4 host-literal bypasses
- Related code: `src/routes/webhooks.ts`, `src/worker/worker.ts`, `src/store/jobStore.ts`, `src/queue/queue.ts`, `src/redisConnection.ts`, `src/index.ts`, `src/types.ts`
