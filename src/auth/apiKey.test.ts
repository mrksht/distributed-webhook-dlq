import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import type { apiKeyAuth as ApiKeyAuth, parseApiKeys as ParseApiKeys, resolveTenant as ResolveTenant } from "./apiKey";

// ./apiKey builds its tenant Map once at module load, reading process.env.API_KEYS at that
// moment (see apiKey.ts). A static top-level `import` here would be hoisted and evaluate before
// this file's own code -- including test.before -- ever runs, so process.env.API_KEYS would
// still be unset by the time the Map is built. Every export below is instead obtained through a
// single dynamic import inside test.before, after the env var is set, and reused by every test.
let parseApiKeys: typeof ParseApiKeys;
let resolveTenant: typeof ResolveTenant;
let apiKeyAuth: typeof ApiKeyAuth;
let webhooksRouter: typeof import("../routes/webhooks").webhooksRouter;

const TENANT_A_KEY = "test-api-key-tenant-a-0123456789";
const TENANT_B_KEY = "test-api-key-tenant-b-abcdef0123";
const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";

const readJson = async (response: Response): Promise<Record<string, unknown>> =>
  (await response.json()) as Record<string, unknown>;

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

// -- parseApiKeys: pure-function unit tests, independent of module-load timing --
// resolveTenant/apiKeyAuth read a Map built once when this module is first imported (see
// apiKey.ts), so exercising different API_KEYS configurations against the live middleware would
// require re-importing the module -- these tests instead call the exported parser directly with
// arbitrary raw strings, covering the same validation logic without any import-timing tricks.

test("parseApiKeys: a key present in API_KEYS resolves to its corresponding tenant id", () => {
  const keys = parseApiKeys(JSON.stringify({ [TENANT_A_KEY]: TENANT_A }));
  assert.equal(keys.get(TENANT_A_KEY), TENANT_A);
});

test("parseApiKeys: two different keys in the same API_KEYS config resolve to two different, correct tenant ids", () => {
  const keys = parseApiKeys(JSON.stringify({ [TENANT_A_KEY]: TENANT_A, [TENANT_B_KEY]: TENANT_B }));
  assert.equal(keys.get(TENANT_A_KEY), TENANT_A);
  assert.equal(keys.get(TENANT_B_KEY), TENANT_B);
  assert.equal(keys.size, 2);
});

test("parseApiKeys: a key not present in the config is absent from the map", () => {
  const keys = parseApiKeys(JSON.stringify({ [TENANT_A_KEY]: TENANT_A }));
  assert.equal(keys.get("some-other-key"), undefined);
});

test("parseApiKeys: unset, empty string, or malformed JSON all fail closed to an empty map without throwing", () => {
  assert.doesNotThrow(() => parseApiKeys(undefined));
  assert.equal(parseApiKeys(undefined).size, 0);

  assert.doesNotThrow(() => parseApiKeys(""));
  assert.equal(parseApiKeys("").size, 0);

  assert.doesNotThrow(() => parseApiKeys("{not valid json"));
  assert.equal(parseApiKeys("{not valid json").size, 0);
});

test("parseApiKeys: syntactically valid JSON that isn't a plain object (null, array, string, number) fails closed to an empty map without throwing", () => {
  for (const raw of ["null", "[]", '["a","b"]', '"just a string"', "42"]) {
    assert.doesNotThrow(() => parseApiKeys(raw), `expected ${raw} not to throw`);
    assert.equal(parseApiKeys(raw).size, 0, `expected ${raw} to produce an empty map`);
  }
});

test("parseApiKeys: an entry with an empty-string key is skipped, not loaded -- a request with an empty Bearer token must not be able to match it", () => {
  const keys = parseApiKeys(JSON.stringify({ "": TENANT_A, [TENANT_B_KEY]: TENANT_B }));
  assert.equal(keys.get(""), undefined);
  assert.equal(keys.get(TENANT_B_KEY), TENANT_B, "the other, valid entry should still load");
});

test("parseApiKeys: an entry with an empty-string tenant id is skipped, not loaded", () => {
  const keys = parseApiKeys(JSON.stringify({ [TENANT_A_KEY]: "", [TENANT_B_KEY]: TENANT_B }));
  assert.equal(keys.get(TENANT_A_KEY), undefined);
  assert.equal(keys.get(TENANT_B_KEY), TENANT_B, "the other, valid entry should still load");
});

test("parseApiKeys: one malformed entry (empty key/tenant id) does not invalidate the rest of an otherwise-valid config", () => {
  const keys = parseApiKeys(
    JSON.stringify({
      [TENANT_A_KEY]: TENANT_A,
      "": "some-tenant",
      [TENANT_B_KEY]: TENANT_B,
    }),
  );
  assert.equal(keys.size, 2, "only the one bad entry should be dropped");
  assert.equal(keys.get(TENANT_A_KEY), TENANT_A);
  assert.equal(keys.get(TENANT_B_KEY), TENANT_B);
});

// -- resolveTenant / apiKeyAuth: integration tests via a real HTTP server --
// API_KEYS must be set before ./apiKey is first imported (its Map is built once at module
// load). test.before runs before every test in this file regardless of declaration order, so
// the pure-function parseApiKeys tests above safely rely on the same dynamic-import assignment
// below -- their bodies only run after this hook completes.

let server: Server;
let baseUrl: string;

const buildTestApp = (): express.Express => {
  const app = express();
  app.use(apiKeyAuth);
  app.get("/protected", (req, res) => {
    res.json({ ok: true, tenant: req.tenant ?? null });
  });
  return app;
};

test.before(async () => {
  process.env.API_KEYS = JSON.stringify({ [TENANT_A_KEY]: TENANT_A, [TENANT_B_KEY]: TENANT_B });
  // Import order matters: ./apiKey first so process.env.API_KEYS is already set when it parses
  // its Map, then ../routes/webhooks -- which itself imports ./apiKey internally -- resolves
  // from Node's module cache and reuses the same, already-configured instance.
  ({ parseApiKeys, resolveTenant, apiKeyAuth } = await import("./apiKey"));
  ({ webhooksRouter } = await import("../routes/webhooks"));
  ({ server, baseUrl } = await listen(buildTestApp()));
});

test.after(async () => {
  await closeServer(server);
});

test("resolveTenant: a configured key resolves to its tenant", () => {
  assert.deepEqual(resolveTenant(TENANT_A_KEY), { id: TENANT_A });
  assert.deepEqual(resolveTenant(TENANT_B_KEY), { id: TENANT_B });
});

test("resolveTenant: an unrecognized key returns null", () => {
  assert.equal(resolveTenant("some-key-not-in-the-config"), null);
});

test("resolveTenant: an empty string key returns null without throwing", () => {
  assert.doesNotThrow(() => resolveTenant(""));
  assert.equal(resolveTenant(""), null);
});

test("apiKeyAuth: correct key in Authorization: Bearer <key> proceeds and attaches the matching req.tenant", async () => {
  const response = await fetch(`${baseUrl}/protected`, {
    headers: { Authorization: `Bearer ${TENANT_A_KEY}` },
  });
  assert.equal(response.status, 200);
  const body = await readJson(response);
  assert.deepEqual(body.tenant, { id: TENANT_A });
});

test("apiKeyAuth: a different configured key attaches its own, different tenant", async () => {
  const response = await fetch(`${baseUrl}/protected`, {
    headers: { Authorization: `Bearer ${TENANT_B_KEY}` },
  });
  assert.equal(response.status, 200);
  const body = await readJson(response);
  assert.deepEqual(body.tenant, { id: TENANT_B });
});

test("apiKeyAuth: missing Authorization header -> 401", async () => {
  const response = await fetch(`${baseUrl}/protected`);
  assert.equal(response.status, 401);
  const body = await readJson(response);
  assert.equal(typeof body.error, "string");
});

test("apiKeyAuth: wrong auth scheme (Basic instead of Bearer) -> 401", async () => {
  const response = await fetch(`${baseUrl}/protected`, {
    headers: { Authorization: `Basic ${TENANT_A_KEY}` },
  });
  assert.equal(response.status, 401);
});

test("apiKeyAuth: Bearer with an empty token -> 401", async () => {
  const response = await fetch(`${baseUrl}/protected`, {
    headers: { Authorization: "Bearer " },
  });
  assert.equal(response.status, 401);
});

test("apiKeyAuth: incorrect key not present in any tenant's config -> 401", async () => {
  const response = await fetch(`${baseUrl}/protected`, {
    headers: { Authorization: "Bearer x".repeat(TENANT_A_KEY.length) },
  });
  assert.equal(response.status, 401);
});

test("apiKeyAuth: key of a different length than any configured key -> 401, request completes cleanly (no crash/500)", async () => {
  const response = await fetch(`${baseUrl}/protected`, {
    headers: { Authorization: "Bearer short" },
  });
  assert.equal(response.status, 401);
  const body = await readJson(response);
  assert.equal(typeof body.error, "string");
});

// Regression: mirrors src/index.ts's mounting order (a route registered directly on `app`
// before `webhooksRouter` is mounted) to prove the router-level `webhooksRouter.use(apiKeyAuth)`
// doesn't leak onto routes that live outside the router -- /health must stay unauthenticated,
// while /webhooks routes (behind the router) require a key.
test("GET /health mounted outside webhooksRouter (as in src/index.ts) remains accessible with no Authorization header", async () => {
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

// The replay route is easy to forget to protect since it's often added last -- test it (and
// GET /webhooks/:id) directly rather than relying only on the router-wide registration being
// structurally correct.
test("GET /webhooks/:id and POST /webhooks/:id/replay both require auth -> 401 with no Authorization header", async () => {
  const app = express();
  app.use(express.json());
  app.use(webhooksRouter);

  const { server: mirrorServer, baseUrl: mirrorBaseUrl } = await listen(app);
  try {
    const getResponse = await fetch(`${mirrorBaseUrl}/webhooks/evt_does-not-exist`);
    assert.equal(getResponse.status, 401);

    const replayResponse = await fetch(`${mirrorBaseUrl}/webhooks/evt_does-not-exist/replay`, {
      method: "POST",
    });
    assert.equal(replayResponse.status, 401);
  } finally {
    await closeServer(mirrorServer);
  }
});
