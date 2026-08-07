import { Queue, Worker } from "bullmq";
import { redisConnection } from "../redisConnection";
import { WebhookJob } from "../types";

export const QUEUE_NAME = "webhook-deliveries";

const queue = new Queue<WebhookJob>(QUEUE_NAME, { connection: redisConnection });

export const enqueue = async (job: WebhookJob): Promise<void> => {
  await queue.add("deliver", job, { attempts: 1 });
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
