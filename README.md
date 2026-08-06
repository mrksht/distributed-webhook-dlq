# distributed-webhook-dlq

Distributed webhook delivery system with retry logic and a dead letter queue.

Current stack: TypeScript, Express, in-memory queue (`EventEmitter`-backed), in-memory job store (`Map`-backed). Not yet distributed — everything runs in a single process. See [Roadmap](#roadmap).

## Setup

```
npm install
npm run dev
```

Server listens on `PORT` (default `3000`).

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
| `QUEUED` | Created, waiting to be picked up by the worker |
| `PROCESSING` | Worker is actively attempting delivery |
| `DELIVERED` | Destination responded with a successful (`2xx`) status |
| `RETRYING` | Delivery failed, waiting for a backoff delay before the next attempt |
| `DEAD_LETTER` | Delivery failed `MAX_ATTEMPTS` (3) times; requires manual replay to try again |

## How it works

```
POST /webhooks → save job (store) → enqueue (queue) → worker → HTTP POST to destination → update status
```

- **Store** (`src/store/jobStore.ts`): in-memory `Map` of jobs, keyed by id. The only place job state is mutated.
- **Queue** (`src/queue/queue.ts`): a private `EventEmitter` wrapped behind `enqueue`/`onJob`, so the underlying mechanism can be swapped out (e.g. for a Redis-backed queue) without changing any call sites.
- **Worker** (`src/worker/worker.ts`): subscribed to the queue via `onJob`. Performs the actual HTTP delivery, retries on failure with linear backoff (`1000ms * attempt count`) up to `MAX_ATTEMPTS`, and marks a job `DEAD_LETTER` once attempts are exhausted.

## Roadmap

- [x] Basic delivery flow (queue → worker → HTTP POST → status update)
- [x] Request validation
- [x] Retry logic with backoff
- [x] Dead letter queue + inspect/replay
- [ ] Actual distribution: swap the in-memory queue for a Redis-backed queue (BullMQ) and run the worker as an independent, horizontally scalable process
