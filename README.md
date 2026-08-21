# distributed-webhook-dlq

Distributed webhook delivery system with retry logic and a dead letter queue.

Stack: TypeScript, Express, [BullMQ](https://docs.bullmq.io/) (Redis-backed queue), Redis-backed job store. The API and the worker run as independent processes that only communicate through Redis — either can be scaled or restarted without the other.

## Setup

Requires a running Redis instance (default `127.0.0.1:6379`, override with `REDIS_HOST`/`REDIS_PORT`).

Copy `.env.example` to `.env` and set `API_KEYS` — a JSON object mapping each project's own API key to a tenant id, e.g. `API_KEYS={"<key-for-project-a>":"project-a","<key-for-project-b>":"project-b"}`. Every `/webhooks` route requires one of these keys; there is no default, so the server rejects every request until it's set (see [Security](#security)).

```
npm install
npm run dev      # API server, listens on PORT (default 3000)
npm run worker   # worker process — run as many of these as you want, in separate terminals
```

Both the API and the worker connect to the same Redis instance. You can run zero, one, or many worker processes; jobs queue up in Redis regardless and get picked up whenever a worker is available. Killing a worker mid-job doesn't lose the job — it stays in Redis until a worker (the same one restarted, or a different one) claims it.

## API

Every route below requires `Authorization: Bearer <your-project's-key>`, where the key is one of the entries configured in `API_KEYS`. A missing or invalid key returns `401`. Which key you use determines which tenant's jobs you can see — see [Security](#security).

### `POST /webhooks`

Creates a job, stores it (tagged with the calling tenant), and enqueues it for delivery. Returns immediately with `QUEUED` — delivery happens asynchronously.

Request:

```
curl -X POST http://localhost:3000/webhooks \
  -H "Authorization: Bearer $YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://webhook.site/xxxx","payload":{"orderId":123,"status":"PAID"}}'
```

Response:

```json
{ "id": "evt_...", "status": "QUEUED" }
```

`400` if `url` is missing, not a valid URL, resolves to a blocked destination (see [Security](#security)), or `payload` is missing.

### `GET /webhooks/:id`

Returns the full job record, including current status and attempt count. `404` if the id doesn't exist, or if it belongs to a different tenant than the caller.

### `GET /webhooks?status=<STATUS>`

Lists all of the calling tenant's jobs currently in the given status (see [Job statuses](#job-statuses)) — never another tenant's. `status` is required; `400` if missing or invalid.

### `POST /webhooks/:id/replay`

Resets a `DEAD_LETTER` job's attempt count to `0` and re-enqueues it for a fresh delivery attempt cycle. `404` if the job doesn't exist or belongs to a different tenant, `400` if it isn't currently `DEAD_LETTER`.

## Security

- **Authentication**: every `/webhooks` route requires `Authorization: Bearer <key>`, checked against `API_KEYS`. `API_KEYS` has no default — generate a key per project with `openssl rand -hex 32`, assign each one a tenant id, and set the resulting JSON object before starting the server (see [Setup](#setup)). `GET /health` is intentionally left unauthenticated.
- **Tenant isolation**: each key belongs to exactly one tenant, and every job is tagged with the tenant that created it. `GET /webhooks/:id`, `GET /webhooks?status=`, and `POST /webhooks/:id/replay` all only ever return or act on the calling tenant's own jobs — a job belonging to a different tenant returns `404`, identical to a job that doesn't exist at all, so no route can leak whether an id exists. This isolation is data/access-only: all tenants share the same operational behavior (retry limits, SSRF blocklist, backoff timing). Adding, removing, or rotating a tenant's key is done by editing `API_KEYS` and restarting — there's no admin endpoint or self-service provisioning. See `src/auth/apiKey.ts`'s `resolveTenant` for the lookup itself.
  - **Migrating from Phase 0's single `API_KEY`**: `API_KEYS` fully replaces it — `API_KEY` is no longer read at all. Replace your single key with a JSON object, e.g. `API_KEYS={"<your-existing-key>":"default"}` to keep using the same key under an explicit tenant id, or mint fresh per-project keys. Any job created before this phase shipped has no tenant tag and becomes permanently inaccessible through the API (by design — see the project's tenant isolation plan in `docs/plans/`).
- **SSRF protection**: the worker only delivers to destinations that resolve to a public IP address, both when a job is created (fast feedback) and again at the exact moment of delivery (the real security boundary — resolving once and connecting to that exact validated IP closes the DNS-rebinding gap a hostname could otherwise exploit between the two checks, which can be minutes apart given retry backoff). Requests to private/loopback/link-local addresses (including cloud metadata endpoints like `169.254.169.254`) are rejected with a generic `400` — this is why `http://localhost` and other local/internal destinations no longer work for manual testing; use a public endpoint like [webhook.site](https://webhook.site) instead.

## Job statuses

| Status | Meaning |
| --- | --- |
| `QUEUED` | Created, waiting to be picked up by a worker |
| `PROCESSING` | A worker is actively attempting delivery |
| `DELIVERED` | Destination responded with a successful (`2xx`) status |
| `RETRYING` | Delivery failed, waiting for a backoff delay before the next attempt |
| `DEAD_LETTER` | Delivery failed permanently; requires manual replay to try again. Usually after `MAX_ATTEMPTS` (3) ordinary failures, but a destination blocked by the SSRF guard (see [Security](#security)) reaches this after a single attempt, since retrying a policy violation would never succeed |

## How it works

```
POST /webhooks → save job (store) → enqueue (queue) → worker → HTTP POST to destination → update status
```

- **Store** (`src/store/jobStore.ts`): job records live in Redis as JSON blobs (`job:<id>` keys), not in process memory — any process, present or future, sees the same data. Every record carries a `tenantId`; `getJob`/`getJobsByStatus` require the caller's tenant id and only ever return that tenant's own data. `getJobsByStatus` does a `SCAN` over all job keys and filters in application code; fine at today's scale, but not indexed, so it wouldn't hold up at high job volume.
- **Queue** (`src/queue/queue.ts`): a thin wrapper around BullMQ's `Queue`/`Worker`, exposing the same `enqueue`/`onJob` shape the rest of the code already used with the old in-memory version — no other file needed to change to make this swap. `enqueue` sets `removeOnComplete`/`removeOnFail` so BullMQ doesn't retain a second, unscoped copy of every job's data in its own Redis keyspace indefinitely.
- **Worker** (`src/worker/worker.ts` + `src/worker/run.ts`): `worker.ts` holds the actual delivery logic (`processJob`), independent of how jobs arrive. `run.ts` is the process entry point (`npm run worker`) that subscribes it to the queue. BullMQ guarantees a given job is only ever claimed by one worker at a time, so running multiple worker processes increases throughput without risking duplicate deliveries — verified directly: 6 jobs sent to 2 concurrent workers each showed exactly `MAX_ATTEMPTS` (3) total attempts combined, never more.
- Retry/backoff/dead-letter logic (attempts tracking, linear backoff, `DEAD_LETTER` after `MAX_ATTEMPTS`) is hand-rolled on top of BullMQ rather than using BullMQ's native retry options — `enqueue` sets `attempts: 1` so BullMQ never retries on its own; every retry is our own explicit re-`enqueue` after a delay.
- **Security** (`src/security/ssrfGuard.ts`, `src/auth/apiKey.ts`): outbound delivery goes through `ssrfSafeFetch` rather than a bare `fetch`, and a destination blocked by policy skips the retry loop entirely — it goes straight to `DEAD_LETTER` (still counted as an attempt) via a `NonRetryableError` the worker checks generically, rather than importing the security module's specific error type. See [Security](#security) for what's blocked and why.

## Roadmap

- [x] Basic delivery flow (queue → worker → HTTP POST → status update)
- [x] Request validation
- [x] Retry logic with backoff
- [x] Dead letter queue + inspect/replay
- [x] Actual distribution: Redis-backed queue (BullMQ) + Redis-backed store, worker as an independent, horizontally scalable process
- [x] Phase 0: SSRF protection + API key authentication
- [x] Phase 1: tenant isolation — per-project API keys, scoped job store, 404 on cross-tenant access
