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

test("enqueue: a job's record no longer persists in BullMQ's own Redis keyspace after it completes (removeOnComplete wired up)", async () => {
  const job = buildJob();

  // A no-op handler -- this test proves BullMQ-level completion/removal is wired up, not
  // delivery logic (that's worker.test.ts's job). Capture the BullMQ-internal job id from the
  // 'completed' event since enqueue() itself returns void.
  const worker = onJob(async () => {});
  try {
    const bullJobId = await new Promise<string>((resolve, reject) => {
      worker.on("completed", (bullJob) => resolve(bullJob.id ?? ""));
      worker.on("failed", (_bullJob, err) => reject(err));
      enqueue(job).catch(reject);
    });

    const queue = new Queue(QUEUE_NAME, { connection: redisConnection });
    try {
      // removeOnComplete fires asynchronously right after the 'completed' event -- poll rather
      // than asserting immediately. The window is generous (up to 5s) since this depends on
      // real BullMQ/Redis scheduling, which can occasionally lag under test-environment load.
      let remaining = await queue.getJob(bullJobId);
      for (let i = 0; i < 50 && remaining; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        remaining = await queue.getJob(bullJobId);
      }
      assert.equal(remaining, undefined, "completed job should have been removed from BullMQ's keyspace");
    } finally {
      await queue.close();
    }
  } finally {
    await worker.close();
  }
});
