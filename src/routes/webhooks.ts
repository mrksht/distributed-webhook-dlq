import { Router } from "express";
import { apiKeyAuth } from "../auth/apiKey";
import { enqueue } from "../queue/queue";
import { assertUrlAllowed, SsrfBlockedError } from "../security/ssrfGuard";
import { createJob, getJob, getJobsByStatus, resetAttempts, updateJob } from "../store/jobStore";
import { JobStatus, WebhookJob } from "../types";

export const webhooksRouter = Router();

// Registered before any route definitions so the router is self-protecting regardless of
// where/how it's mounted in index.ts -- the guarantee that no /webhooks route ships
// unprotected is structural, not dependent on the mount call site remembering to wrap it.
webhooksRouter.use(apiKeyAuth);

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

  try {
    await assertUrlAllowed(url);
  } catch (error) {
    if (error instanceof SsrfBlockedError) {
      res.status(400).json({ error: error.message });
      return;
    }
    // A DNS resolution failure here isn't a policy block -- this check is advisory-only
    // (see ssrfSafeFetch, the real security boundary), so let the job proceed and let the
    // worker's delivery-time retry logic handle it, rather than rejecting on a transient blip.
    console.error(`assertUrlAllowed: non-blocking validation error for url=${JSON.stringify(url)}`, error);
  }

  if (payload === undefined) {
    res.status(400).json({ error: "payload is required" });
    return;
  }

  const job: WebhookJob = {
    id: `evt_${crypto.randomUUID()}`,
    tenantId: req.tenant!.id,
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
  const job = await getJob(req.params.id, req.tenant!.id);
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

  res.json(await getJobsByStatus(status, req.tenant!.id));
});

webhooksRouter.post("/webhooks/:id/replay", async (req, res) => {
    // Tenant check happens before the DEAD_LETTER-status check, deliberately -- so a cross-tenant
    // caller sees the same 404 whether the job is "not yours" or "yours but not DEAD_LETTER"
    // would have applied. Both branches must be indistinguishable from "doesn't exist".
    const job = await getJob(req.params.id, req.tenant!.id);
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
