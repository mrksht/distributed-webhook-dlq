import Redis from "ioredis";
import { redisConnection } from "../redisConnection";
import { WebhookJob } from "../types";

const redis = new Redis(redisConnection);

const jobKey = (id: string) => `job:${id}`;

const parseJob = (raw: string): WebhookJob => {
  const parsed = JSON.parse(raw);
  return {
    ...parsed,
    createdAt: new Date(parsed.createdAt),
    updatedAt: new Date(parsed.updatedAt),
  };
};

export const createJob = async (job: WebhookJob): Promise<void> => {
  await redis.set(jobKey(job.id), JSON.stringify(job));
};

export const getJob = async (id: string): Promise<WebhookJob | undefined> => {
  const raw = await redis.get(jobKey(id));
  return raw ? parseJob(raw) : undefined;
};

export const updateJob = async (id: string, status: WebhookJob["status"]): Promise<boolean> => {
  const job = await getJob(id);
  if (!job) {
    return false;
  }
  job.status = status;
  job.updatedAt = new Date();
  await redis.set(jobKey(id), JSON.stringify(job));
  return true;
};

export const incrementAttempts = async (id: string): Promise<number> => {
  const job = await getJob(id);
  if (!job) {
    return 0;
  }
  job.attempts += 1;
  job.updatedAt = new Date();
  await redis.set(jobKey(id), JSON.stringify(job));
  return job.attempts;
};

export const resetAttempts = async (id: string): Promise<boolean> => {
  const job = await getJob(id);
  if (!job) {
    return false;
  }
  job.attempts = 0;
  job.updatedAt = new Date();
  await redis.set(jobKey(id), JSON.stringify(job));
  return true;
};

export const getJobsByStatus = async (status: WebhookJob["status"]): Promise<WebhookJob[]> => {
  const result: WebhookJob[] = [];
  let cursor = "0";
  do {
    const [nextCursor, keys] = await redis.scan(cursor, "MATCH", "job:*", "COUNT", 100);
    cursor = nextCursor;
    if (keys.length > 0) {
      const values = await redis.mget(keys);
      for (const raw of values) {
        if (raw) {
          const job = parseJob(raw);
          if (job.status === status) {
            result.push(job);
          }
        }
      }
    }
  } while (cursor !== "0");
  return result;
};
