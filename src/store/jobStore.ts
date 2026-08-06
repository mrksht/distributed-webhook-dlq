import { WebhookJob } from "../types";

const jobs = new Map<string, WebhookJob>();

export const createJob = (job: WebhookJob) => {
  jobs.set(job.id, job);
}

export const getJob = (id: string): WebhookJob | undefined => {
  return jobs.get(id);
}

export const updateJob = (id: string, status: WebhookJob['status']): boolean => {
  const job = jobs.get(id);
  if (!job) {
    return false;
  }
  job.status = status;
  job.updatedAt = new Date();
  return true;
}

export const incrementAttempts = (id: string): number => {
  const job = jobs.get(id);
  if (!job) {
    return 0;
  }
  job.attempts += 1;
  job.updatedAt = new Date();
  return job.attempts;
}

export const resetAttempts = (id: string): boolean => {
  const job = jobs.get(id);
  if (!job) {
    return false;
  }
  job.attempts = 0;
  job.updatedAt = new Date();
  return true;
}

export const getJobsByStatus = (status: WebhookJob['status']): WebhookJob[] => {
  const result: WebhookJob[] = [];
  for (const job of jobs.values()) {
    if (job.status === status) {
      result.push(job);
    }
  }
  return result;
}
