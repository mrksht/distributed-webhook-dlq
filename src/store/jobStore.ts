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

// Not exported. Fetches by bare id with no tenant check -- only for this module's own
// read-modify-write mutators below (updateJob, incrementAttempts, resetAttempts), which are
// only ever reached by route code after an authorized getJob already succeeded, or by the
// worker acting on a job it already holds from the queue -- never with an attacker-controlled
// id and no prior authorization step. The public getJob, below, is the only tenant-checked read.
const getJobUnscoped = async (id: string): Promise<WebhookJob | undefined> => {
  const raw = await redis.get(jobKey(id));
  return raw ? parseJob(raw) : undefined;
};

// Returns undefined both when the id doesn't exist and when it belongs to a different tenant --
// the two cases are structurally indistinguishable to every caller outside this module, so a
// route can't accidentally leak "the job exists, it's just not yours" by forgetting a check.
export const getJob = async (id: string, tenantId: string): Promise<WebhookJob | undefined> => {
  const job = await getJobUnscoped(id);
  return job && job.tenantId === tenantId ? job : undefined;
};

export const updateJob = async (id: string, status: WebhookJob["status"]): Promise<boolean> => {
  const job = await getJobUnscoped(id);
  if (!job) {
    return false;
  }
  job.status = status;
  job.updatedAt = new Date();
  await redis.set(jobKey(id), JSON.stringify(job));
  return true;
};

export const incrementAttempts = async (id: string): Promise<number> => {
  const job = await getJobUnscoped(id);
  if (!job) {
    return 0;
  }
  job.attempts += 1;
  job.updatedAt = new Date();
  await redis.set(jobKey(id), JSON.stringify(job));
  return job.attempts;
};

export const resetAttempts = async (id: string): Promise<boolean> => {
  const job = await getJobUnscoped(id);
  if (!job) {
    return false;
  }
  job.attempts = 0;
  job.updatedAt = new Date();
  await redis.set(jobKey(id), JSON.stringify(job));
  return true;
};

// Filters on both status and tenantId in the same SCAN+MGET pass -- same unindexed approach as
// before (see the plan's Scope Boundaries), now scoped. This briefly holds every tenant's full
// job payload in process memory before filtering discards non-matches; never log or dump the
// raw MGET results given that.
export const getJobsByStatus = async (status: WebhookJob["status"], tenantId: string): Promise<WebhookJob[]> => {
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
          if (job.status === status && job.tenantId === tenantId) {
            result.push(job);
          }
        }
      }
    }
  } while (cursor !== "0");
  return result;
};
