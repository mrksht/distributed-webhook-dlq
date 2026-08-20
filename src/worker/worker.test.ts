import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import Redis from "ioredis";
import { processJob } from "./worker";
import { redisConnection } from "../redisConnection";
import { createJob, getJob } from "../store/jobStore";
import { JobStatus, WebhookJob } from "../types";

// A domain guaranteed by RFC 2606 to never resolve -- used to simulate an
// ordinary (non-SSRF) delivery failure, distinct from a blocked destination.
const UNRESOLVABLE_URL = "http://this-domain-should-not-resolve-abc123xyz.invalid/";

// Separate raw client purely for test cleanup.
const redis = new Redis(redisConnection);
const createdJobIds: string[] = [];

const buildJob = (url: string): WebhookJob => {
  const id = `evt_test_${crypto.randomUUID()}`;
  createdJobIds.push(id);
  return {
    id,
    tenantId: "test-tenant",
    url,
    payload: { hello: "world" },
    status: JobStatus.QUEUED,
    createdAt: new Date(),
    updatedAt: new Date(),
    attempts: 0,
  };
};

test.after(async () => {
  if (createdJobIds.length > 0) {
    await redis.del(...createdJobIds.map((id) => `job:${id}`));
  }
  redis.disconnect();
});

test("processJob: a url that passes creation-time validation but resolves to a blocked IP at delivery time goes straight to DEAD_LETTER on the first attempt", async () => {
  const job = buildJob("http://169.254.169.254/");
  await createJob(job);

  await processJob(job);

  const stored = await getJob(job.id, job.tenantId);
  assert.equal(stored?.status, JobStatus.DEAD_LETTER);
  assert.equal(stored?.attempts, 1, "a blocked attempt still counts as an attempt");
});

test("processJob: an ordinary delivery failure (unresolvable hostname) still goes through the RETRYING -> DEAD_LETTER cycle, unchanged", async () => {
  const job = buildJob(UNRESOLVABLE_URL);
  await createJob(job);

  await processJob(job);
  let stored = await getJob(job.id, job.tenantId);
  assert.equal(stored?.status, JobStatus.RETRYING);
  assert.equal(stored?.attempts, 1);

  await processJob(job);
  stored = await getJob(job.id, job.tenantId);
  assert.equal(stored?.status, JobStatus.RETRYING);
  assert.equal(stored?.attempts, 2);

  await processJob(job);
  stored = await getJob(job.id, job.tenantId);
  assert.equal(stored?.status, JobStatus.DEAD_LETTER);
  assert.equal(stored?.attempts, 3);
});
