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
