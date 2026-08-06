# distributed-webhook-dlq

Distributed webhook delivery system with retry logic and a dead letter queue.

## Phase 1 — simplest version (no retries yet)

```
POST /webhooks → save job → queue → worker → HTTP POST to destination → update status
```

Stack for phase 1: Express, in-memory queue, in-memory job store.

## Setup

```
npm install
npm run dev
```
