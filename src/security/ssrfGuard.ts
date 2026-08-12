// Built against undici v6.23.x (bundled internally by Node 22's native fetch). undici's `connect`
// hook isn't an officially stable API -- if a future upgrade removes it, the redirect test in
// ssrfGuard.test.ts fails loudly rather than silently reopening the SSRF hole.
import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import { Agent, buildConnector } from "undici";
import { NonRetryableError } from "../errors";

export class SsrfBlockedError extends NonRetryableError {
  constructor(message = "destination not allowed") {
    super(message);
    this.name = "SsrfBlockedError";
    Object.setPrototypeOf(this, SsrfBlockedError.prototype);
  }
}

const DNS_LOOKUP_TIMEOUT_MS = 5_000;

// RFC1918, loopback, link-local (incl. cloud metadata 169.254.169.254), CGNAT, 0.0.0.0/8.
// ipaddr.js doesn't export its range-name types, so these are plain strings vs .range()'s return.
const BLOCKED_IPV4_RANGES = new Set<string>(["private", "loopback", "linkLocal", "carrierGradeNat", "unspecified"]);

// ::1, fc00::/7, fe80::/10, :: -- blocked outright, no decoding needed. "unspecified" (::) is the
// IPv6 analog of 0.0.0.0 above and was missing here in an earlier version -- caught by review,
// verified reachable to a loopback-bound server via http://[::]:<port>/.
const BLOCKED_IPV6_RANGES = new Set<string>(["loopback", "uniqueLocal", "linkLocal", "unspecified"]);

// TS can't narrow ipaddr.js's IPv4 | IPv6 union on a .kind() method call, only a discriminant property.
const isIPv4Address = (addr: ipaddr.IPv4 | ipaddr.IPv6): addr is ipaddr.IPv4 => addr.kind() === "ipv4";

const wordsToIPv4 = (high: number, low: number): ipaddr.IPv4 =>
  new ipaddr.IPv4([(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff]);

// Decodes the IPv4 embedded in an IPv6 transition address for the prefixes ipaddr.js classifies
// but doesn't itself decode (ipv4Mapped it does decode natively, via addr.toIPv4Address()).
// Teredo's embedded client IPv4 is XOR-obfuscated per RFC4380.
const decodeEmbeddedIPv4 = (addr: ipaddr.IPv6, range: string): ipaddr.IPv4 | null => {
  const parts = addr.parts;
  switch (range) {
    case "ipv4Mapped":
      return addr.toIPv4Address();
    case "rfc6052":
      // 64:ff9b::/96 -- embedded IPv4 occupies the last 32 bits verbatim.
      return wordsToIPv4(parts[6], parts[7]);
    case "6to4":
      // 2002:WWXX:YYZZ::/16 -- embedded IPv4 occupies bits 16-48 verbatim.
      return wordsToIPv4(parts[1], parts[2]);
    case "teredo":
      // RFC4380 -- the client IPv4 in the last 32 bits is obfuscated by
      // XORing every bit with 1.
      return wordsToIPv4(parts[6] ^ 0xffff, parts[7] ^ 0xffff);
    default:
      return null;
  }
};

const isBlockedIPv4 = (addr: ipaddr.IPv4): boolean => BLOCKED_IPV4_RANGES.has(addr.range());

const stripBrackets = (hostname: string): string =>
  hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;

const isBlockedAddress = (address: string): boolean => {
  const parsed = ipaddr.parse(stripBrackets(address));
  if (isIPv4Address(parsed)) {
    return isBlockedIPv4(parsed);
  }

  const range = parsed.range();
  if (BLOCKED_IPV6_RANGES.has(range)) {
    return true;
  }

  const embedded = decodeEmbeddedIPv4(parsed, range);
  return embedded !== null && isBlockedIPv4(embedded);
};

// This bounds how long a caller waits, not the underlying dns.lookup call itself -- Node's
// dns/promises has no cancellation, so a timed-out lookup keeps occupying a libuv threadpool slot
// (default 4) until it resolves on its own. A handful of concurrent slow/black-holed-DNS
// destinations can exhaust the threadpool and stall unrelated lookups app-wide. Flagged by review
// (2 independent reviewers); accepted for now given no rate limiting exists yet in this phase --
// worth addressing (concurrency cap, or dns.resolve4/6 instead of lookup) alongside rate limiting.
const withTimeout = <T>(promise: Promise<T>, ms: number, message: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });

export interface ResolveAndValidateResult {
  blocked: boolean;
  addresses: string[];
}

// Single source of truth shared by assertUrlAllowed and ssrfSafeFetch's connect hook, so the two
// call sites can't drift. Fails closed: any blocked resolved address blocks the whole result.
// A DNS failure propagates as an ordinary rejection, not SsrfBlockedError -- different outcome,
// different retry semantics.
export const resolveAndValidate = async (hostname: string): Promise<ResolveAndValidateResult> => {
  const target = stripBrackets(hostname);

  const records = await withTimeout(
    lookup(target, { all: true, verbatim: true }),
    DNS_LOOKUP_TIMEOUT_MS,
    `DNS lookup for "${target}" timed out after ${DNS_LOOKUP_TIMEOUT_MS}ms`,
  );

  const addresses = records.map((record) => record.address);
  const blocked = addresses.some((address) => isBlockedAddress(address));
  return { blocked, addresses };
};

// Fast, creation-time-only check -- not itself a security boundary (see ssrfSafeFetch), since
// retries happen minutes apart and DNS can rebind in between. The thrown message is deliberately
// generic; resolution detail is logged server-side only, not handed to an authenticated caller
// as a probe for internal hosts.
export const assertUrlAllowed = async (url: string): Promise<void> => {
  const hostname = new URL(url).hostname;
  const result = await resolveAndValidate(hostname);
  if (result.blocked) {
    console.error(
      `assertUrlAllowed: blocked destination for url=${JSON.stringify(url)} hostname=${JSON.stringify(hostname)} addresses=[${result.addresses.join(", ")}]`,
    );
    throw new SsrfBlockedError();
  }
};

// The plain TCP/TLS connector undici would otherwise use by default. Reused
// as-is except for the hostname/servername override applied below.
const defaultConnector = buildConnector({});

type Connector = ReturnType<typeof buildConnector>;

// Exported (connector injectable, defaulting to the real one) so tests can verify the per-hop
// resolve+classify+pin decision deterministically -- without it, proving that a redirect's target
// gets independently re-validated would require a live two-hop network round trip where the
// "allowed" hop is itself unblocked, which no local-only test server can be (any loopback-bound
// server is blocked by the same classifier being tested).
export const createConnectHandler = (connector: Connector = defaultConnector): Connector => {
  return (connectOpts, callback) => {
    const originalHostname = connectOpts.hostname;

    resolveAndValidate(originalHostname).then(
      (result) => {
        if (result.blocked) {
          callback(new SsrfBlockedError(), null);
          return;
        }

        // Pin the raw connection to the validated IP, but keep the original hostname as
        // `servername` so TLS SNI and cert verification still target the real host, not the IP.
        connector(
          {
            ...connectOpts,
            hostname: result.addresses[0],
            servername: originalHostname,
          },
          callback,
        );
      },
      (dnsError) => {
        // Ordinary DNS failure, not a policy block -- propagate unchanged.
        callback(dnsError, null);
      },
    );
  };
};

// Module-scope singleton (matches queue.ts/jobStore.ts) -- rebuilding per call would forgo
// connection-pool reuse for no benefit, since connect closes over nothing per-request.
const dispatcher = new Agent({ connect: createConnectHandler() });

// Because `connect` above fires for every socket the dispatcher opens -- including a redirect to
// a different origin -- this closes the redirect-based bypass with no separate redirect-handling
// code, and re-validates on every retry attempt.
export const ssrfSafeFetch = async (url: string, options: RequestInit = {}): Promise<Response> => {
  try {
    return await fetch(url, { ...options, dispatcher });
  } catch (error) {
    // fetch always wraps a connector-level failure in `TypeError: fetch failed` with the real
    // error on `.cause`, rather than propagating it directly. Unwrapped, this would silently
    // strip SsrfBlockedError's identity before worker.ts ever sees it, defeating the retry-skip.
    if (error instanceof Error && error.cause instanceof NonRetryableError) {
      throw error.cause;
    }
    throw error;
  }
};
