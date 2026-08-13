import { timingSafeEqual } from "node:crypto";
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

// Zero Express coupling by design -- this is the actual lookup, reusable outside an HTTP
// context (e.g. a future admin CLI). Only the middleware below touches req/res/next.
// Today it's a single shared-secret comparison against API_KEY; swapping in a Redis-backed
// per-tenant lookup later changes only this function's body.
export const resolveTenant = (key: string): Tenant | null => {
  const expected = process.env.API_KEY;

  // Fail closed, checked as its own condition BEFORE any comparison runs. This deliberately
  // does NOT follow redisConnection.ts's `process.env.X ?? <default>` convention -- that's
  // fine for a non-secret with a safe default, wrong for a secret. Concretely:
  // crypto.timingSafeEqual does NOT throw when comparing two zero-length buffers, it returns
  // true -- so without this guard, an unset API_KEY plus an empty Bearer token would
  // authenticate successfully.
  if (expected === undefined || expected.length === 0) {
    return null;
  }

  const providedBuffer = Buffer.from(key);
  const expectedBuffer = Buffer.from(expected);

  // timingSafeEqual throws on unequal-length buffers -- check first, and treat a mismatch as
  // "not authenticated", not as a thrown error that crashes the request.
  if (providedBuffer.length !== expectedBuffer.length) {
    return null;
  }

  if (!timingSafeEqual(providedBuffer, expectedBuffer)) {
    return null;
  }

  return { id: "default" };
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
