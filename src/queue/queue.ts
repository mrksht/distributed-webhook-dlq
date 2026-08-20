import { Queue, Worker } from "bullmq";
import { redisConnection } from "../redisConnection";
import { WebhookJob } from "../types";

export const QUEUE_NAME = "webhook-deliveries";

const queue = new Queue<WebhookJob>(QUEUE_NAME, { connection: redisConnection });

export const enqueue = async (job: WebhookJob): Promise<void> => {
  // removeOnComplete/removeOnFail: BullMQ otherwise retains every job's full data (including
  // tenantId, url, payload) indefinitely in its own Redis keyspace, unscoped by tenant and
  // outside jobStore.ts's scoping guarantees entirely. This narrows the retention window; it
  // doesn't add tenant scoping to BullMQ's own data -- any future code that reads BullMQ job
  // state directly (dashboards, admin tooling) must apply the same tenant check as the routes.
  await queue.add("deliver", job, { attempts: 1, removeOnComplete: true, removeOnFail: true });
};

export const onJob = (handler: (job: WebhookJob) => Promise<void> | void): Worker<WebhookJob> => {
  return new Worker<WebhookJob>(
    QUEUE_NAME,
    async (job) => {
      await handler(job.data);
    },
    { connection: redisConnection },
  );
};
