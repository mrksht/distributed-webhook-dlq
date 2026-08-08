import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { apiKeyAuth, resolveTenant } from "./apiKey";
import { webhooksRouter } from "../routes/webhooks";

const TEST_API_KEY = "test-api-key-0123456789abcdef";

const readJson = async (response: Response): Promise<Record<string, unknown>> =>
  (await response.json()) as Record<string, unknown>;

const buildTestApp = (): express.Express => {
  const app = express();
  app.use(apiKeyAuth);
  app.get("/protected", (req, res) => {
    res.json({ ok: true, tenant: req.tenant ?? null });
  });
  return app;
};

const listen = (app: express.Express): Promise<{ server: Server; baseUrl: string }> =>
  new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : 0;
      resolve({ server, baseUrl: `http://127.0.0.1:${port}` });
    });
  });

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve) => server.close(() => resolve()));

const withApiKey = async <T>(value: string | undefined, fn: () => Promise<T>): Promise<T> => {
  const original = process.env.API_KEY;
  if (value === undefined) {
    delete process.env.API_KEY;
  } else {
    process.env.API_KEY = value;
  }
  try {
    return await fn();
  } finally {
    if (original === undefined) {
      delete process.env.API_KEY;
    } else {
      process.env.API_KEY = original;
    }
  }
};

let server: Server;
let baseUrl: string;

test.before(async () => {
  process.env.API_KEY = TEST_API_KEY;
  ({ server, baseUrl } = await listen(buildTestApp()));
});

test.after(async () => {
  await closeServer(server);
});

// -- resolveTenant: pure-function unit tests (no Express involved) --

test("resolveTenant: correct key returns the placeholder tenant", () => {
  assert.deepEqual(resolveTenant(TEST_API_KEY), { id: "default" });
});

test("resolveTenant: incorrect key (same length, wrong value) returns null", () => {
  const wrongKey = "x".repeat(TEST_API_KEY.length);
  assert.equal(resolveTenant(wrongKey), null);
});

test("resolveTenant: key of a different length than expected returns null without throwing", () => {
  assert.doesNotThrow(() => resolveTenant("short"));
  assert.equal(resolveTenant("short"), null);
  assert.doesNotThrow(() => resolveTenant(TEST_API_KEY + "extra-suffix-making-it-longer"));
  assert.equal(resolveTenant(TEST_API_KEY + "extra-suffix-making-it-longer"), null);
});

test("resolveTenant: unset API_KEY rejects every key, including an empty one -- proves the fail-closed check runs independently of the length+timingSafeEqual comparison (two zero-length buffers would otherwise compare equal)", async () => {
  await withApiKey(undefined, async () => {
    assert.equal(resolveTenant(""), null);
    assert.equal(resolveTenant("anything"), null);
  });
});

test("resolveTenant: empty-string API_KEY rejects every key, including an empty one", async () => {
  await withApiKey("", async () => {
    assert.equal(resolveTenant(""), null);
    assert.equal(resolveTenant("anything"), null);
  });
});

// -- apiKeyAuth middleware: integration tests via a real HTTP server --

test("apiKeyAuth: correct key in Authorization: Bearer <key> proceeds and attaches req.tenant", async () => {
  const response = await fetch(`${baseUrl}/protected`, {
    headers: { Authorization: `Bearer ${TEST_API_KEY}` },
  });
  assert.equal(response.status, 200);
  const body = await readJson(response);
  assert.deepEqual(body.tenant, { id: "default" });
});

test("apiKeyAuth: missing Authorization header -> 401", async () => {
  const response = await fetch(`${baseUrl}/protected`);
  assert.equal(response.status, 401);
  const body = await readJson(response);
  assert.equal(typeof body.error, "string");
});

test("apiKeyAuth: wrong auth scheme (Basic instead of Bearer) -> 401", async () => {
  const response = await fetch(`${baseUrl}/protected`, {
    headers: { Authorization: `Basic ${TEST_API_KEY}` },
  });
  assert.equal(response.status, 401);
});

test("apiKeyAuth: Bearer with an empty token -> 401", async () => {
  const response = await fetch(`${baseUrl}/protected`, {
    headers: { Authorization: "Bearer " },
  });
  assert.equal(response.status, 401);
});

test("apiKeyAuth: incorrect key (right length, wrong value) -> 401", async () => {
  const wrongKey = "x".repeat(TEST_API_KEY.length);
  const response = await fetch(`${baseUrl}/protected`, {
    headers: { Authorization: `Bearer ${wrongKey}` },
  });
  assert.equal(response.status, 401);
});

test("apiKeyAuth: key of a different length than expected -> 401, request completes cleanly (no crash/500)", async () => {
  const response = await fetch(`${baseUrl}/protected`, {
    headers: { Authorization: "Bearer short" },
  });
  assert.equal(response.status, 401);
  const body = await readJson(response);
  assert.equal(typeof body.error, "string");
});

test("apiKeyAuth: API_KEY unset -> every request rejected, including one with an empty Bearer token (the specific bypass this design prevents)", async () => {
  await withApiKey(undefined, async () => {
    const { server: unauthServer, baseUrl: unauthBaseUrl } = await listen(buildTestApp());
    try {
      const emptyTokenResponse = await fetch(`${unauthBaseUrl}/protected`, {
        headers: { Authorization: "Bearer " },
      });
      assert.equal(emptyTokenResponse.status, 401);

      const anyTokenResponse = await fetch(`${unauthBaseUrl}/protected`, {
        headers: { Authorization: "Bearer anything" },
      });
      assert.equal(anyTokenResponse.status, 401);
    } finally {
      await closeServer(unauthServer);
    }
  });
});

test("apiKeyAuth: API_KEY set to empty string -> every request rejected, including one with an empty Bearer token", async () => {
  await withApiKey("", async () => {
    const { server: emptyKeyServer, baseUrl: emptyKeyBaseUrl } = await listen(buildTestApp());
    try {
      const response = await fetch(`${emptyKeyBaseUrl}/protected`, {
        headers: { Authorization: "Bearer " },
      });
      assert.equal(response.status, 401);
    } finally {
      await closeServer(emptyKeyServer);
    }
  });
});

// Regression: mirrors src/index.ts's mounting order (a route registered directly on `app`
// before `webhooksRouter` is mounted) to prove the router-level `webhooksRouter.use(apiKeyAuth)`
// added in this unit doesn't leak onto routes that live outside the router -- /health must stay
// unauthenticated, while /webhooks routes (now behind the router) require the key.
test("GET /health mounted outside webhooksRouter (as in src/index.ts) remains accessible with no Authorization header", async () => {
  await withApiKey(TEST_API_KEY, async () => {
    const app = express();
    app.use(express.json());
    app.get("/health", (_req, res) => {
      res.json({ status: "ok" });
    });
    app.use(webhooksRouter);

    const { server: mirrorServer, baseUrl: mirrorBaseUrl } = await listen(app);
    try {
      const healthResponse = await fetch(`${mirrorBaseUrl}/health`);
      assert.equal(healthResponse.status, 200);
      const healthBody = await readJson(healthResponse);
      assert.equal(healthBody.status, "ok");

      const webhooksResponse = await fetch(`${mirrorBaseUrl}/webhooks?status=QUEUED`);
      assert.equal(webhooksResponse.status, 401);
    } finally {
      await closeServer(mirrorServer);
    }
  });
});
