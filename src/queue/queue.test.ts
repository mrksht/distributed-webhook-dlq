import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { Queue } from "bullmq";
import { enqueue, onJob, QUEUE_NAME } from "./queue";
import { redisConnection } from "../redisConnection";
import { JobStatus, WebhookJob } from "../types";

const buildJob = (): WebhookJob => ({
  id: `evt_test_${crypto.randomUUID()}`,
  tenantId: "test-tenant",
  url: "https://example.com/",
  payload: { hello: "world" },
  status: JobStatus.QUEUED,
  createdAt: new Date(),
  updatedAt: new Date(),
  attempts: 0,
});

// Polls until a BullMQ job disappears from the queue's keyspace, or the attempt budget runs out.
const waitForRemoval = async (queue: Queue, bullJobId: string) => {
  let remaining = await queue.getJob(bullJobId);
  for (let i = 0; i < 50 && remaining; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    remaining = await queue.getJob(bullJobId);
  }
  return remaining;
};

test("enqueue: a job's record no longer persists in BullMQ's own Redis keyspace after it completes (removeOnComplete wired up)", async () => {
  const job = buildJob();

  // A no-op handler -- this test proves BullMQ-level completion/removal is wired up, not
  // delivery logic (that's worker.test.ts's job). Capture the BullMQ-internal job id from the
  // 'completed' event since enqueue() itself returns void. Filtered on bullJob.data.id ===
  // job.id: this queue name is shared with webhooks.test.ts (a separate, concurrently-running
  // node:test process against the same real Redis) and with any leftover jobs from prior runs,
  // so an unfiltered listener could resolve on the wrong job entirely.
  const worker = onJob(async () => {});
  try {
    const bullJobId = await new Promise<string>((resolve, reject) => {
      worker.on("completed", (bullJob) => {
        if (bullJob.data.id === job.id) resolve(bullJob.id ?? "");
      });
      worker.on("failed", (bullJob, err) => {
        if (bullJob?.data.id === job.id) reject(err);
      });
      enqueue(job).catch(reject);
    });

    const queue = new Queue(QUEUE_NAME, { connection: redisConnection });
    try {
      // removeOnComplete fires asynchronously right after the 'completed' event -- poll rather
      // than asserting immediately. The window is generous (up to 5s) since this depends on
      // real BullMQ/Redis scheduling, which can occasionally lag under test-environment load.
      const remaining = await waitForRemoval(queue, bullJobId);
      assert.equal(remaining, undefined, "completed job should have been removed from BullMQ's keyspace");
    } finally {
      await queue.close();
    }
  } finally {
    await worker.close();
  }
});

test("enqueue: a failed job's record is kept (bounded retention), not deleted immediately like a completed job (removeOnFail: { count: 1000 } wired up)", async () => {
  const job = buildJob();

  // A handler that always throws -- drives the job to BullMQ's "failed" state (as opposed to
  // "completed") so removeOnFail's own retention behavior gets exercised, not just
  // removeOnComplete's. attempts: 1 (set in queue.ts's enqueue) means BullMQ never retries, so
  // this reaches "failed" after exactly one attempt. Unlike removeOnComplete: true (immediate
  // deletion), removeOnFail: { count: 1000 } deliberately keeps recent failures inspectable --
  // see the comment in queue.ts's enqueue for why -- so this asserts the record still exists
  // shortly after failing, the opposite of the removeOnComplete test above.
  const worker = onJob(async () => {
    throw new Error("simulated delivery failure for removeOnFail coverage");
  });
  try {
    const bullJobId = await new Promise<string>((resolve, reject) => {
      worker.on("completed", (bullJob) => {
        if (bullJob.data.id === job.id) reject(new Error("expected this job to fail, not complete"));
      });
      worker.on("failed", (bullJob) => {
        if (bullJob?.data.id === job.id) resolve(bullJob.id ?? "");
      });
      enqueue(job).catch(reject);
    });

    const queue = new Queue(QUEUE_NAME, { connection: redisConnection });
    try {
      const stillPresent = await queue.getJob(bullJobId);
      assert.ok(stillPresent, "failed job should still be present -- bounded retention, not immediate deletion");
      assert.equal(await stillPresent.getState(), "failed");
    } finally {
      await queue.close();
    }
  } finally {
    await worker.close();
  }
});
