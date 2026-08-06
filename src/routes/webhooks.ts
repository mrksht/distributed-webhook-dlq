import { Router } from "express";
import { enqueue } from "../queue/queue";
import { createJob, getJob } from "../store/jobStore";
import { WebhookJob } from "../types";

export const webhooksRouter = Router();

webhooksRouter.post("/webhooks", (req, res) => {
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
    status: "QUEUED",
    createdAt: new Date(),
    updatedAt: new Date(),
    attempts: 0,
  };
  createJob(job);
  enqueue(job);
  res.json({ id: job.id, status: "QUEUED" });
});

webhooksRouter.get("/webhooks/:id", (req, res) => {
  const job = getJob(req.params.id);
  if (!job) {
    res.status(404).json({ error: "job not found" });
    return;
  }
  res.json(job);
});
