import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import Redis from "ioredis";
import { webhooksRouter } from "./webhooks";
import { redisConnection } from "../redisConnection";
import * as jobStore from "../store/jobStore";
import { JobStatus } from "../types";

const readJson = async (response: Response): Promise<Record<string, unknown>> =>
  (await response.json()) as Record<string, unknown>;

// A separate raw client purely for test cleanup -- jobStore.ts's own redis
// client is module-private and doesn't expose a delete/close primitive.
const redis = new Redis(redisConnection);
const createdJobIds: string[] = [];

let server: Server;
let baseUrl: string;

test.before(async () => {
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

test("POST /webhooks: a URL resolving to a public IP behaves exactly as before (regression)", async () => {
  const response = await fetch(`${baseUrl}/webhooks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ url: "https://example.com/", payload: { hello: "world" } }),
  });

  assert.equal(response.status, 200);
  const body = await readJson(response);
  assert.equal(body.status, JobStatus.QUEUED);
  assert.ok(typeof body.id === "string" && body.id.length > 0);
  const jobId = body.id as string;
  createdJobIds.push(jobId);

  const stored = await jobStore.getJob(jobId);
  assert.ok(stored, "job should have been created in the store");
  assert.equal(stored?.status, JobStatus.QUEUED);
  assert.equal(stored?.url, "https://example.com/");
});

test("POST /webhooks: a URL resolving to a loopback IP is rejected with 400 and no job is created", async () => {
  const keysBefore = new Set(await redis.keys("job:*"));

  const response = await fetch(`${baseUrl}/webhooks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
    headers: { "Content-Type": "application/json" },
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

test("POST /webhooks: the 400 body for a blocked url is a generic message, not the resolved IP or matched rule", async () => {
  const response = await fetch(`${baseUrl}/webhooks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
