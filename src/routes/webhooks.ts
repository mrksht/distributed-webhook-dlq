import { Router } from "express";
import { enqueue } from "../queue/queue";
import { createJob, getJob, getJobsByStatus, resetAttempts, updateJob } from "../store/jobStore";
import { JobStatus, WebhookJob } from "../types";

export const webhooksRouter = Router();

webhooksRouter.post("/webhooks", async (req, res) => {
  const { url, payload } = req.body;

  if (typeof url !== "string" || url.length === 0) {
    res.status(400).json({ error: "url is required and must be a string" });
    return;
  }

  try {
    new URL(url);
  } catch {
    res.status(400).json({ error: "url must be a valid URL" });
    return;
  }

  if (payload === undefined) {
    res.status(400).json({ error: "payload is required" });
    return;
  }

  const job: WebhookJob = {
    id: `evt_${crypto.randomUUID()}`,
    url,
    payload,
    status: JobStatus.QUEUED,
    createdAt: new Date(),
    updatedAt: new Date(),
    attempts: 0,
  };
  await createJob(job);
  await enqueue(job);
  res.json({ id: job.id, status: JobStatus.QUEUED });
});

webhooksRouter.get("/webhooks/:id", async (req, res) => {
  const job = await getJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: "job not found" });
    return;
  }
  res.json(job);
});

webhooksRouter.get("/webhooks", async (req, res) => {
  const status = req.query.status as JobStatus | undefined;
  if (!status || !Object.values(JobStatus).includes(status)) {
    res.status(400).json({ error: "status query param is required and must be a valid status" });
    return;
  }

  res.json(await getJobsByStatus(status));
});

webhooksRouter.post("/webhooks/:id/replay", async (req, res) => {
    const job = await getJob(req.params.id);
    if (!job) {
        res.status(404).json({ error: "job not found" });
        return;
    }
    if (job.status !== JobStatus.DEAD_LETTER) {
        res.status(400).json({ error: "only DEAD_LETTER jobs can be replayed" });
        return;
    }
    await updateJob(job.id, JobStatus.QUEUED);
    await resetAttempts(job.id);
    await enqueue(job);
    res.json({ id: job.id, status: JobStatus.QUEUED });
});
