# distributed-webhook-dlq

Distributed webhook delivery system with retry logic and a dead letter queue.

Stack: TypeScript, Express, [BullMQ](https://docs.bullmq.io/) (Redis-backed queue), Redis-backed job store. The API and the worker run as independent processes that only communicate through Redis — either can be scaled or restarted without the other.

## Setup

Requires a running Redis instance (default `127.0.0.1:6379`, override with `REDIS_HOST`/`REDIS_PORT`).

Copy `.env.example` to `.env` and set `API_KEY` — every `/webhooks` route requires it; there is no default, so the server rejects every request until it's set (see [Security](#security)).

```
npm install
npm run dev      # API server, listens on PORT (default 3000)
npm run worker   # worker process — run as many of these as you want, in separate terminals
```

Both the API and the worker connect to the same Redis instance. You can run zero, one, or many worker processes; jobs queue up in Redis regardless and get picked up whenever a worker is available. Killing a worker mid-job doesn't lose the job — it stays in Redis until a worker (the same one restarted, or a different one) claims it.

## API

Every route below requires `Authorization: Bearer <API_KEY>`. A missing or invalid key returns `401`.

### `POST /webhooks`

Creates a job, stores it, and enqueues it for delivery. Returns immediately with `QUEUED` — delivery happens asynchronously.

Request:

```
curl -X POST http://localhost:3000/webhooks \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://webhook.site/xxxx","payload":{"orderId":123,"status":"PAID"}}'
```

Response:

```json
{ "id": "evt_...", "status": "QUEUED" }
```

`400` if `url` is missing, not a valid URL, resolves to a blocked destination (see [Security](#security)), or `payload` is missing.

### `GET /webhooks/:id`

Returns the full job record, including current status and attempt count. `404` if the id doesn't exist.

### `GET /webhooks?status=<STATUS>`

Lists all jobs currently in the given status (see [Job statuses](#job-statuses)). `status` is required; `400` if missing or invalid.

### `POST /webhooks/:id/replay`

Resets a `DEAD_LETTER` job's attempt count to `0` and re-enqueues it for a fresh delivery attempt cycle. `404` if the job doesn't exist, `400` if it isn't currently `DEAD_LETTER`.

## Security

- **Authentication**: every `/webhooks` route requires `Authorization: Bearer <API_KEY>`. `API_KEY` has no default — generate one with `openssl rand -hex 32` and set it before starting the server. `GET /health` is intentionally left unauthenticated.
- **SSRF protection**: the worker only delivers to destinations that resolve to a public IP address, both when a job is created (fast feedback) and again at the exact moment of delivery (the real security boundary — resolving once and connecting to that exact validated IP closes the DNS-rebinding gap a hostname could otherwise exploit between the two checks, which can be minutes apart given retry backoff). Requests to private/loopback/link-local addresses (including cloud metadata endpoints like `169.254.169.254`) are rejected with a generic `400` — this is why `http://localhost` and other local/internal destinations no longer work for manual testing; use a public endpoint like [webhook.site](https://webhook.site) instead.
- This is a single-tenant setup: one shared `API_KEY` grants full access to every job. See `src/auth/apiKey.ts`'s `resolveTenant` for the seam a future per-project key system would extend.

## Job statuses

| Status | Meaning |
| --- | --- |
| `QUEUED` | Created, waiting to be picked up by a worker |
| `PROCESSING` | A worker is actively attempting delivery |
| `DELIVERED` | Destination responded with a successful (`2xx`) status |
| `RETRYING` | Delivery failed, waiting for a backoff delay before the next attempt |
| `DEAD_LETTER` | Delivery failed `MAX_ATTEMPTS` (3) times; requires manual replay to try again |

## How it works

```
POST /webhooks → save job (store) → enqueue (queue) → worker → HTTP POST to destination → update status
```

- **Store** (`src/store/jobStore.ts`): job records live in Redis as JSON blobs (`job:<id>` keys), not in process memory — any process, present or future, sees the same data. `getJobsByStatus` does a `SCAN` over all job keys and filters in application code; fine at today's scale, but not indexed, so it wouldn't hold up at high job volume.
- **Queue** (`src/queue/queue.ts`): a thin wrapper around BullMQ's `Queue`/`Worker`, exposing the same `enqueue`/`onJob` shape the rest of the code already used with the old in-memory version — no other file needed to change to make this swap.
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
