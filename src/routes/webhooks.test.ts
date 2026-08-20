import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import Redis from "ioredis";
import type { webhooksRouter as WebhooksRouter } from "./webhooks";
import { redisConnection } from "../redisConnection";
import * as jobStore from "../store/jobStore";
import { JobStatus } from "../types";

const readJson = async (response: Response): Promise<Record<string, unknown>> =>
  (await response.json()) as Record<string, unknown>;

// This suite covers SSRF-guard integration and tenant scoping. Two tenants are configured so
// cross-tenant tests have a second, real tenant to assert against. ./webhooks (via ./apiKey)
// builds its tenant Map once at module load, reading process.env.API_KEYS at that moment -- a
// static top-level `import` would be hoisted and evaluate before this file's own code runs, so
// the dynamic import in test.before is what makes setting the env var here actually take
// effect (see src/auth/apiKey.test.ts for the same pattern with more detail).
const TENANT_A_KEY = "webhooks-test-suite-tenant-a-key";
const TENANT_B_KEY = "webhooks-test-suite-tenant-b-key";
const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";
const tenantAHeaders = { Authorization: `Bearer ${TENANT_A_KEY}` };
const tenantBHeaders = { Authorization: `Bearer ${TENANT_B_KEY}` };

// A separate raw client purely for test cleanup -- jobStore.ts's own redis
// client is module-private and doesn't expose a delete/close primitive.
const redis = new Redis(redisConnection);
const createdJobIds: string[] = [];

let webhooksRouter: typeof WebhooksRouter;
let server: Server;
let baseUrl: string;

test.before(async () => {
  process.env.API_KEYS = JSON.stringify({ [TENANT_A_KEY]: TENANT_A, [TENANT_B_KEY]: TENANT_B });
  ({ webhooksRouter } = await import("./webhooks"));

  const app = express();
  app.use(express.json());
  app.use(webhooksRouter);

  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  baseUrl = `http://127.0.0.1:${port}`;
});

test.after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (createdJobIds.length > 0) {
    await redis.del(...createdJobIds.map((id) => `job:${id}`));
  }
  redis.disconnect();
});

const createJob = async (headers: Record<string, string>, url = "https://example.com/"): Promise<string> => {
  const response = await fetch(`${baseUrl}/webhooks`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ url, payload: { hello: "world" } }),
  });
  assert.equal(response.status, 200);
  const body = await readJson(response);
  const id = body.id as string;
  createdJobIds.push(id);
  return id;
};

test("POST /webhooks: a URL resolving to a public IP behaves exactly as before (regression)", async () => {
  const response = await fetch(`${baseUrl}/webhooks`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...tenantAHeaders },
    body: JSON.stringify({ url: "https://example.com/", payload: { hello: "world" } }),
  });

  assert.equal(response.status, 200);
  const body = await readJson(response);
  assert.equal(body.status, JobStatus.QUEUED);
  assert.ok(typeof body.id === "string" && body.id.length > 0);
  const jobId = body.id as string;
  createdJobIds.push(jobId);

  const stored = await jobStore.getJob(jobId, TENANT_A);
  assert.ok(stored, "job should have been created in the store");
  assert.equal(stored?.status, JobStatus.QUEUED);
  assert.equal(stored?.url, "https://example.com/");
  assert.equal(stored?.tenantId, TENANT_A);
});

test("POST /webhooks: a URL resolving to a loopback IP is rejected with 400 and no job is created", async () => {
  const keysBefore = new Set(await redis.keys("job:*"));

  const response = await fetch(`${baseUrl}/webhooks`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...tenantAHeaders },
    body: JSON.stringify({ url: "http://127.0.0.1/", payload: { hello: "world" } }),
  });

  assert.equal(response.status, 400);
  const body = await readJson(response);
  assert.equal(typeof body.error, "string");
  assert.ok(body.id === undefined, "no job id should be returned for a blocked url");

  const keysAfter = await redis.keys("job:*");
  const newKeys = keysAfter.filter((key) => !keysBefore.has(key));
  assert.deepEqual(newKeys, [], "no job key should have been written to the store for a blocked url");
});

test("POST /webhooks: a URL resolving to a link-local/cloud-metadata IP is rejected with 400 and no job is created", async () => {
  const keysBefore = new Set(await redis.keys("job:*"));

  const response = await fetch(`${baseUrl}/webhooks`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...tenantAHeaders },
    body: JSON.stringify({ url: "http://169.254.169.254/", payload: { hello: "world" } }),
  });

  assert.equal(response.status, 400);
  const body = await readJson(response);
  assert.equal(typeof body.error, "string");
  assert.ok(body.id === undefined, "no job id should be returned for a blocked url");

  const keysAfter = await redis.keys("job:*");
  const newKeys = keysAfter.filter((key) => !keysBefore.has(key));
  assert.deepEqual(newKeys, [], "no job key should have been written to the store for a blocked url");
});

test("POST /webhooks: a URL with an unresolvable hostname is not a policy block -- the request succeeds and the job is created (not a crash, not a 400)", async () => {
  const response = await fetch(`${baseUrl}/webhooks`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...tenantAHeaders },
    body: JSON.stringify({
      url: "http://this-domain-should-not-resolve-abc123xyz.invalid/",
      payload: { hello: "world" },
    }),
  });

  assert.equal(response.status, 200);
  const body = await readJson(response);
  assert.equal(body.status, JobStatus.QUEUED);
  assert.ok(typeof body.id === "string" && body.id.length > 0);
  createdJobIds.push(body.id as string);
});

test("POST /webhooks: the 400 body for a blocked url is a generic message, not the resolved IP or matched rule", async () => {
  const response = await fetch(`${baseUrl}/webhooks`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...tenantAHeaders },
    body: JSON.stringify({ url: "http://169.254.169.254/", payload: { hello: "world" } }),
  });

  assert.equal(response.status, 400);
  const body = await readJson(response);
  assert.equal(typeof body.error, "string");
  const errorMessage = body.error as string;
  assert.ok(!errorMessage.includes("169.254.169.254"), `error leaked the resolved IP: ${errorMessage}`);
  assert.ok(
    !/linkLocal|private|loopback|carrierGradeNat|unspecified/i.test(errorMessage),
    `error leaked the matched rule: ${errorMessage}`,
  );
});

// -- Tenant scoping (U3) --

test("GET /webhooks/:id: tenant A can read back a job it created", async () => {
  const jobId = await createJob(tenantAHeaders);

  const response = await fetch(`${baseUrl}/webhooks/${jobId}`, { headers: tenantAHeaders });
  assert.equal(response.status, 200);
  const body = await readJson(response);
  assert.equal(body.id, jobId);
});

test("GET /webhooks/:id: tenant B gets 404 for a job created by tenant A (covers AE1)", async () => {
  const jobId = await createJob(tenantAHeaders);

  const response = await fetch(`${baseUrl}/webhooks/${jobId}`, { headers: tenantBHeaders });
  assert.equal(response.status, 404);
});

test("GET /webhooks/:id: the 404 body for a cross-tenant job is byte-identical to the body for a genuinely nonexistent id", async () => {
  const jobId = await createJob(tenantAHeaders);

  const crossTenantResponse = await fetch(`${baseUrl}/webhooks/${jobId}`, { headers: tenantBHeaders });
  const nonexistentResponse = await fetch(`${baseUrl}/webhooks/evt_does-not-exist`, { headers: tenantBHeaders });

  assert.equal(crossTenantResponse.status, nonexistentResponse.status);
  assert.equal(await crossTenantResponse.text(), await nonexistentResponse.text());
});

test("GET /webhooks?status=: tenant A sees only its own matching jobs, never tenant B's (covers AE2)", async () => {
  const tenantAJobId = await createJob(tenantAHeaders);
  const tenantBJobId = await createJob(tenantBHeaders);

  const response = await fetch(`${baseUrl}/webhooks?status=${JobStatus.QUEUED}`, { headers: tenantAHeaders });
  assert.equal(response.status, 200);
  const body = (await response.json()) as Array<{ id: string }>;
  const ids = body.map((job) => job.id);

  assert.ok(ids.includes(tenantAJobId));
  assert.ok(!ids.includes(tenantBJobId), "tenant B's job must not appear in tenant A's listing");
});

test("POST /webhooks/:id/replay: tenant B gets 404 replaying tenant A's job, and the job's status/attempts are unchanged (covers AE1)", async () => {
  const jobId = await createJob(tenantAHeaders);
  await jobStore.updateJob(jobId, JobStatus.DEAD_LETTER);

  const response = await fetch(`${baseUrl}/webhooks/${jobId}/replay`, {
    method: "POST",
    headers: tenantBHeaders,
  });
  assert.equal(response.status, 404);

  const stored = await jobStore.getJob(jobId, TENANT_A);
  assert.equal(stored?.status, JobStatus.DEAD_LETTER, "tenant A's job must be untouched by tenant B's replay attempt");
  assert.equal(stored?.attempts, 0);
});

test("POST /webhooks/:id/replay: the 404 body for a cross-tenant job is byte-identical to the body for a genuinely nonexistent id", async () => {
  const jobId = await createJob(tenantAHeaders);
  await jobStore.updateJob(jobId, JobStatus.DEAD_LETTER);

  const crossTenantResponse = await fetch(`${baseUrl}/webhooks/${jobId}/replay`, {
    method: "POST",
    headers: tenantBHeaders,
  });
  const nonexistentResponse = await fetch(`${baseUrl}/webhooks/evt_does-not-exist/replay`, {
    method: "POST",
    headers: tenantBHeaders,
  });

  assert.equal(crossTenantResponse.status, nonexistentResponse.status);
  assert.equal(await crossTenantResponse.text(), await nonexistentResponse.text());
});

test("POST /webhooks/:id/replay: tenant A can replay its own DEAD_LETTER job end-to-end (proves scoping isn't over-restrictive for the legitimate owner)", async () => {
  const jobId = await createJob(tenantAHeaders);
  await jobStore.updateJob(jobId, JobStatus.DEAD_LETTER);
  await jobStore.incrementAttempts(jobId);

  const response = await fetch(`${baseUrl}/webhooks/${jobId}/replay`, {
    method: "POST",
    headers: tenantAHeaders,
  });
  assert.equal(response.status, 200);
  const body = await readJson(response);
  assert.equal(body.status, JobStatus.QUEUED);

  const stored = await jobStore.getJob(jobId, TENANT_A);
  assert.equal(stored?.status, JobStatus.QUEUED);
  assert.equal(stored?.attempts, 0);
});

