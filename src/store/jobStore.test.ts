import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import Redis from "ioredis";
import { createJob, getJob, getJobsByStatus, incrementAttempts, resetAttempts, updateJob } from "./jobStore";
import { redisConnection } from "../redisConnection";
import { JobStatus, WebhookJob } from "../types";

const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";

// Separate raw client purely for test setup/cleanup -- jobStore.ts's own redis client is
// module-private and doesn't expose a delete primitive or a way to write a pre-Phase-1 record.
const redis = new Redis(redisConnection);
const createdJobIds: string[] = [];

const buildJob = (tenantId: string, status: WebhookJob["status"] = JobStatus.QUEUED): WebhookJob => {
  const id = `evt_test_${crypto.randomUUID()}`;
  createdJobIds.push(id);
  return {
    id,
    tenantId,
    url: "https://example.com/",
    payload: { hello: "world" },
    status,
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

test("getJob: returns the job when the tenant matches", async () => {
  const job = buildJob(TENANT_A);
  await createJob(job);

  const stored = await getJob(job.id, TENANT_A);
  assert.ok(stored);
  assert.equal(stored?.id, job.id);
  assert.equal(stored?.tenantId, TENANT_A);
});

test("getJob: returns undefined for a job that exists but belongs to another tenant", async () => {
  const job = buildJob(TENANT_A);
  await createJob(job);

  const stored = await getJob(job.id, TENANT_B);
  assert.equal(stored, undefined);
});

test("getJob: a wrong-tenant lookup and a nonexistent-id lookup return the identical undefined -- indistinguishable by construction (covers AE1)", async () => {
  const job = buildJob(TENANT_A);
  await createJob(job);

  const wrongTenant = await getJob(job.id, TENANT_B);
  const nonexistent = await getJob("evt_does-not-exist", TENANT_B);
  assert.equal(wrongTenant, undefined);
  assert.equal(nonexistent, undefined);
  assert.equal(wrongTenant, nonexistent);
});

test("getJobsByStatus: returns only the caller's tenant's matching jobs when multiple tenants share the same status (covers AE2)", async () => {
  const tenantAJob1 = buildJob(TENANT_A, JobStatus.QUEUED);
  const tenantAJob2 = buildJob(TENANT_A, JobStatus.QUEUED);
  const tenantBJob = buildJob(TENANT_B, JobStatus.QUEUED);
  await Promise.all([createJob(tenantAJob1), createJob(tenantAJob2), createJob(tenantBJob)]);

  const results = await getJobsByStatus(JobStatus.QUEUED, TENANT_A);
  const resultIds = results.map((job) => job.id);

  assert.ok(resultIds.includes(tenantAJob1.id));
  assert.ok(resultIds.includes(tenantAJob2.id));
  assert.ok(!resultIds.includes(tenantBJob.id), "another tenant's job must not appear");
});

test("getJob / getJobsByStatus: a pre-Phase-1 job with no tenantId (written directly, bypassing createJob) is orphaned -- not returned for any real tenant id", async () => {
  const id = `evt_test_${crypto.randomUUID()}`;
  createdJobIds.push(id);
  const legacyRecord = {
    id,
    url: "https://example.com/",
    payload: { hello: "world" },
    status: JobStatus.QUEUED,
    createdAt: new Date(),
    updatedAt: new Date(),
    attempts: 0,
    // no tenantId field -- simulates data written before this phase
  };
  await redis.set(`job:${id}`, JSON.stringify(legacyRecord));

  assert.equal(await getJob(id, TENANT_A), undefined);
  assert.equal(await getJob(id, TENANT_B), undefined);

  const results = await getJobsByStatus(JobStatus.QUEUED, TENANT_A);
  assert.ok(!results.map((job) => job.id).includes(id));
});

test("updateJob / incrementAttempts / resetAttempts: still operate by bare id after the internal getJobUnscoped refactor", async () => {
  const job = buildJob(TENANT_A);
  await createJob(job);

  assert.equal(await updateJob(job.id, JobStatus.PROCESSING), true);
  let stored = await getJob(job.id, TENANT_A);
  assert.equal(stored?.status, JobStatus.PROCESSING);

  assert.equal(await incrementAttempts(job.id), 1);
  stored = await getJob(job.id, TENANT_A);
  assert.equal(stored?.attempts, 1);

  assert.equal(await resetAttempts(job.id), true);
  stored = await getJob(job.id, TENANT_A);
  assert.equal(stored?.attempts, 0);
});

test("updateJob / incrementAttempts / resetAttempts: return a falsy/zero result for a nonexistent id, unchanged from before", async () => {
  assert.equal(await updateJob("evt_does-not-exist", JobStatus.PROCESSING), false);
  assert.equal(await incrementAttempts("evt_does-not-exist"), 0);
  assert.equal(await resetAttempts("evt_does-not-exist"), false);
});
