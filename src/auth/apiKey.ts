import type { NextFunction, Request, Response } from "express";

// Module augmentation lives here (rather than a separate .d.ts) since this is the only file
// that needs it and the project has no existing .d.ts convention to follow.
declare global {
  namespace Express {
    interface Request {
      tenant?: Tenant;
    }
  }
}

export interface Tenant {
  id: string;
}

const BEARER_PREFIX = "Bearer ";

// Parses API_KEYS (a JSON object of apiKey -> tenantId pairs) once at module load. Fails
// closed, not loudly-crashing: an unset/empty/malformed value, or a non-object shape
// (JSON.parse succeeds on "null"/"[]"/"42" without throwing -- those are rejected here too, not
// just JSON.parse failures) fall back to an empty Map. This repo has no multi-replica/
// health-check-gated deployment, so crashing at import time (before app.listen runs) would take
// down the whole API -- including the unauthenticated /health route -- with no auto-recovery.
// An empty Map is behaviorally equivalent from a "nobody gets in" standpoint (every request
// 401s) with a much smaller blast radius.
//
// An individual entry with an empty-string key or tenant id is skipped, not treated as a
// whole-config failure -- a typo made while adding one tenant shouldn't also lock out every
// other already-working tenant. Skipping (rather than accepting) still closes the bug this
// guards against: crypto.timingSafeEqual-style zero-length-buffer bypasses don't apply to
// Map.get, but an accidentally-empty key would still let `Authorization: Bearer ` (empty
// token) match it, so it's dropped instead of loaded.
//
// Every log line below deliberately omits the raw API_KEYS value and any individual key/tenant
// id -- API_KEYS is a blob of every tenant's plaintext secret, so even naming "the bad entry"
// by its key would leak a real credential into logs.
export const parseApiKeys = (raw: string | undefined): Map<string, string> => {
  const failAll = (reason: string): Map<string, string> => {
    console.error(`apiKey: API_KEYS is invalid (${reason}) -- falling back to an empty key set, every request will 401`);
    return new Map();
  };

  if (raw === undefined || raw.length === 0) {
    return failAll("unset or empty");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return failAll("not valid JSON");
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return failAll("must be a JSON object of apiKey -> tenantId pairs");
  }

  const keys = new Map<string, string>();
  let skipped = 0;

  for (const [apiKey, tenantId] of Object.entries(parsed as Record<string, unknown>)) {
    if (apiKey.length === 0 || typeof tenantId !== "string" || tenantId.length === 0) {
      skipped += 1;
      continue;
    }
    keys.set(apiKey, tenantId);
  }

  if (skipped > 0) {
    console.error(
      `apiKey: API_KEYS has ${skipped} entr${skipped === 1 ? "y" : "ies"} with an empty key or tenant id -- skipped, remaining valid entries still loaded`,
    );
  }

  return keys;
};

const tenantsByKey = parseApiKeys(process.env.API_KEYS);

// Zero Express coupling by design -- this is the actual lookup, reusable outside an HTTP
// context (e.g. a future admin CLI). Only the middleware below touches req/res/next.
// V8's Map.get hashes the candidate key and looks up its bucket; a miss (the overwhelming
// majority of wrong guesses) returns undefined with zero content comparisons against any real
// key -- only a hash-bucket collision falls through to a non-constant-time compare. For this
// consumer set (a handful of known, non-adversarial projects) that's an acceptable tradeoff
// against reintroducing a linear timingSafeEqual scan across every configured key.
export const resolveTenant = (key: string): Tenant | null => {
  const tenantId = tenantsByKey.get(key);
  return tenantId === undefined ? null : { id: tenantId };
};

// Turns the "apiKeyAuth always runs first" invariant into an explicit, named check instead of a
// bare `req.tenant!.id` at each call site. Should never throw given the router-wide middleware
// mount in webhooks.ts, but if that invariant is ever violated (e.g. a future route mounted
// outside the router), this throws a clear error that index.ts's error-handling middleware turns
// into a 500, rather than a raw non-null-assertion TypeError surfacing as an unhandled rejection.
export const requireTenant = (req: Request): Tenant => {
  if (!req.tenant) {
    throw new Error("requireTenant called on a request apiKeyAuth did not authenticate");
  }
  return req.tenant;
};

// The only thing in this module that touches Express. Reads the Authorization header, defers
// the actual key check to resolveTenant, and attaches the resulting tenant to req so
// downstream handlers never need a signature change to become tenant-aware.
export const apiKeyAuth = (req: Request, res: Response, next: NextFunction): void => {
  const header = req.header("Authorization");

  if (!header || !header.startsWith(BEARER_PREFIX)) {
    res.status(401).json({ error: "missing or malformed Authorization header" });
    return;
  }

  const key = header.slice(BEARER_PREFIX.length);
  const tenant = resolveTenant(key);
  if (!tenant) {
    res.status(401).json({ error: "invalid API key" });
    return;
  }

  req.tenant = tenant;
  next();
};
