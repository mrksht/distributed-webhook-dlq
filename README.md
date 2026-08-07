# distributed-webhook-dlq

Distributed webhook delivery system with retry logic and a dead letter queue.

Stack: TypeScript, Express, [BullMQ](https://docs.bullmq.io/) (Redis-backed queue), Redis-backed job store. The API and the worker run as independent processes that only communicate through Redis — either can be scaled or restarted without the other.

## Setup

Requires a running Redis instance (default `127.0.0.1:6379`, override with `REDIS_HOST`/`REDIS_PORT`).

```
npm install
npm run dev      # API server, listens on PORT (default 3000)
npm run worker   # worker process — run as many of these as you want, in separate terminals
```

Both the API and the worker connect to the same Redis instance. You can run zero, one, or many worker processes; jobs queue up in Redis regardless and get picked up whenever a worker is available. Killing a worker mid-job doesn't lose the job — it stays in Redis until a worker (the same one restarted, or a different one) claims it.

## API

### `POST /webhooks`

Creates a job, stores it, and enqueues it for delivery. Returns immediately with `QUEUED` — delivery happens asynchronously.

Request body:

```json
{
  "url": "https://webhook.site/xxxx",
  "payload": { "orderId": 123, "status": "PAID" }
}
```

Response:

```json
{ "id": "evt_...", "status": "QUEUED" }
```

`400` if `url` is missing/not a valid URL, or `payload` is missing.

### `GET /webhooks/:id`

Returns the full job record, including current status and attempt count. `404` if the id doesn't exist.

### `GET /webhooks?status=<STATUS>`

Lists all jobs currently in the given status (see [Job statuses](#job-statuses)). `status` is required; `400` if missing or invalid.

### `POST /webhooks/:id/replay`

Resets a `DEAD_LETTER` job's attempt count to `0` and re-enqueues it for a fresh delivery attempt cycle. `404` if the job doesn't exist, `400` if it isn't currently `DEAD_LETTER`.

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

## Roadmap

- [x] Basic delivery flow (queue → worker → HTTP POST → status update)
- [x] Request validation
- [x] Retry logic with backoff
- [x] Dead letter queue + inspect/replay
- [x] Actual distribution: Redis-backed queue (BullMQ) + Redis-backed store, worker as an independent, horizontally scalable process
