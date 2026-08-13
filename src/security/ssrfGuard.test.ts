import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import dnsPromises from "node:dns/promises";
import { NonRetryableError } from "../errors";
import { assertUrlAllowed, createConnectHandler, resolveAndValidate, ssrfSafeFetch, SsrfBlockedError } from "./ssrfGuard";

// A domain guaranteed by RFC 2606 to never resolve, for NXDOMAIN scenarios.
const UNRESOLVABLE_HOST = "this-domain-should-not-resolve-abc123xyz.invalid";

test("resolveAndValidate: hostname resolving only to a public IP is allowed", async () => {
  const result = await resolveAndValidate("example.com");
  assert.equal(result.blocked, false);
  assert.ok(result.addresses.length > 0);
});

test("resolveAndValidate: literal public IP is allowed", async () => {
  const result = await resolveAndValidate("1.1.1.1");
  assert.equal(result.blocked, false);
});

test("ssrfSafeFetch: real HTTPS destination with a valid certificate succeeds", async () => {
  const response = await ssrfSafeFetch("https://example.com/");
  assert.equal(response.status, 200);
});

test("resolveAndValidate: RFC1918 ranges are blocked", async () => {
  for (const address of ["10.1.2.3", "172.16.0.5", "172.31.255.254", "192.168.1.1"]) {
    const result = await resolveAndValidate(address);
    assert.equal(result.blocked, true, `expected ${address} to be blocked`);
  }
});

test("resolveAndValidate: loopback is blocked", async () => {
  assert.equal((await resolveAndValidate("127.0.0.1")).blocked, true);
  assert.equal((await resolveAndValidate("::1")).blocked, true);
});

test("resolveAndValidate: link-local including cloud metadata is blocked", async () => {
  assert.equal((await resolveAndValidate("169.254.169.254")).blocked, true);
  assert.equal((await resolveAndValidate("169.254.1.1")).blocked, true);
});

test("resolveAndValidate: IPv6 unique-local and link-local are blocked", async () => {
  assert.equal((await resolveAndValidate("fc00::1")).blocked, true);
  assert.equal((await resolveAndValidate("fe80::1")).blocked, true);
});

test("resolveAndValidate: IPv6 unspecified address (::) is blocked -- the IPv6 analog of 0.0.0.0", async () => {
  assert.equal((await resolveAndValidate("::")).blocked, true);
});

test("resolveAndValidate: IPv4-mapped IPv6 is blocked", async () => {
  const result = await resolveAndValidate("::ffff:10.0.0.1");
  assert.equal(result.blocked, true);
});

test("resolveAndValidate: NAT64/6to4/Teredo with embedded private IPv4 are blocked", async () => {
  // NAT64 (RFC6052, 64:ff9b::/96) -- embedded IPv4 in the last 32 bits, verbatim.
  assert.equal((await resolveAndValidate("64:ff9b::10.0.0.1")).blocked, true);
  // 6to4 (RFC3056, 2002::/16) -- embedded IPv4 in bits 16-48, verbatim: 10.0.0.1 -> 0a00:0001.
  assert.equal((await resolveAndValidate("2002:0a00:0001::")).blocked, true);
  // Teredo (RFC4380, 2001::/32) -- client IPv4 in the last 32 bits, XORed with all-1s:
  // 10.0.0.1 -> ~0x0a000001 -> 0xf5fffffe -> f5ff:fffe.
  assert.equal((await resolveAndValidate("2001::f5ff:fffe")).blocked, true);
});

test("resolveAndValidate: CGNAT and 0.0.0.0/8 are blocked", async () => {
  assert.equal((await resolveAndValidate("100.64.0.1")).blocked, true);
  assert.equal((await resolveAndValidate("100.127.255.254")).blocked, true);
  assert.equal((await resolveAndValidate("0.0.0.0")).blocked, true);
});

test("assertUrlAllowed: decimal, octal, and hex IPv4 literal encodings of 127.0.0.1 are blocked", async () => {
  await assert.rejects(() => assertUrlAllowed("http://2130706433/"), SsrfBlockedError);
  await assert.rejects(() => assertUrlAllowed("http://017700000001/"), SsrfBlockedError);
  await assert.rejects(() => assertUrlAllowed("http://0x7f000001/"), SsrfBlockedError);
});

test("resolveAndValidate: fails closed when only some resolved addresses are blocked", async (t) => {
  t.mock.method(dnsPromises, "lookup", async () => [
    { address: "8.8.8.8", family: 4 },
    { address: "10.0.0.5", family: 4 },
  ]);
  const result = await resolveAndValidate("mixed.example");
  assert.equal(result.blocked, true, "any blocked address must block the whole result");
});

test("resolveAndValidate: unresolvable hostname rejects as an ordinary error, not a policy block", async () => {
  await assert.rejects(
    () => resolveAndValidate(UNRESOLVABLE_HOST),
    (error: unknown) => {
      assert.ok(!(error instanceof SsrfBlockedError));
      assert.ok(!(error instanceof NonRetryableError));
      return true;
    },
  );
});

test("assertUrlAllowed: unresolvable hostname rejects as an ordinary error, not SsrfBlockedError/NonRetryableError", async () => {
  await assert.rejects(
    () => assertUrlAllowed(`http://${UNRESOLVABLE_HOST}/`),
    (error: unknown) => {
      assert.ok(!(error instanceof SsrfBlockedError));
      assert.ok(!(error instanceof NonRetryableError));
      return true;
    },
  );
});

test("ssrfSafeFetch: unresolvable hostname rejects as an ordinary error, not SsrfBlockedError/NonRetryableError", async () => {
  await assert.rejects(
    () => ssrfSafeFetch(`http://${UNRESOLVABLE_HOST}/`),
    (error: unknown) => {
      assert.ok(!(error instanceof SsrfBlockedError));
      assert.ok(!(error instanceof NonRetryableError));
      return true;
    },
  );
});

test("ssrfSafeFetch: a directly-requested blocked address is rejected via the connect hook", async () => {
  // NOTE: this only proves the connect hook blocks a directly-requested blocked address -- it
  // does NOT prove redirect-target re-validation, since the request target here (127.0.0.1) is
  // itself loopback-blocked and rejects before any redirect could be followed. Proving "the
  // redirect target gets independently re-validated" via a live two-hop request isn't possible
  // with only local test infrastructure: any locally-reachable server is itself loopback-blocked
  // by the same classifier under test, so there's no way to make the *first* hop succeed. See the
  // "connect handler" test below, which verifies per-hostname re-validation deterministically
  // instead, without depending on a real network round trip.
  const server = http.createServer((_req, res) => {
    res.writeHead(302, { Location: "http://169.254.169.254/secret" });
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    const port = address && typeof address === "object" ? address.port : 0;
    await assert.rejects(() => ssrfSafeFetch(`http://127.0.0.1:${port}/`), SsrfBlockedError);
  } finally {
    server.close();
  }
});

test("connect handler: independently resolves and classifies every hostname it's invoked with -- proves per-hop re-validation without a live network round trip", async (t) => {
  t.mock.method(dnsPromises, "lookup", async (hostname: string) => {
    if (hostname === "allowed-hop.example") {
      return [{ address: "93.184.216.34", family: 4 }];
    }
    return [{ address: "127.0.0.1", family: 4 }];
  });

  const connectorCalls: Array<{ hostname: string; servername?: string }> = [];
  const fakeConnector = ((opts: { hostname: string; servername?: string }, callback: (err: Error | null, socket: null) => void) => {
    connectorCalls.push({ hostname: opts.hostname, servername: opts.servername });
    callback(null, null);
  }) as Parameters<typeof createConnectHandler>[0];

  const connect = createConnectHandler(fakeConnector);

  // First "hop": an allowed hostname reaches the (fake) connector, pinned to the resolved IP,
  // with the original hostname preserved as servername.
  await new Promise<void>((resolve, reject) => {
    connect({ hostname: "allowed-hop.example" } as Parameters<typeof connect>[0], (err: Error | null, _socket: unknown) =>
      err ? reject(err) : resolve(),
    );
  });
  assert.equal(connectorCalls.length, 1);
  assert.equal(connectorCalls[0].hostname, "93.184.216.34");
  assert.equal(connectorCalls[0].servername, "allowed-hop.example");

  // Second "hop" (simulating a redirect target on the same dispatcher): a different, blocked
  // hostname is independently resolved and rejected -- proving the handler doesn't cache or
  // reuse the first hop's decision, which is exactly what happens across a real redirect since
  // undici invokes connect fresh for each socket the dispatcher opens.
  await assert.rejects(
    () =>
      new Promise((resolve, reject) => {
        connect({ hostname: "still-blocked.example" } as Parameters<typeof connect>[0], (err: Error | null, _socket: unknown) =>
          err ? reject(err) : resolve(undefined),
        );
      }),
    SsrfBlockedError,
  );
  assert.equal(connectorCalls.length, 1, "a blocked hostname must never reach the connector");
});

test("ssrfSafeFetch: a blocked destination surfaces as SsrfBlockedError, and error instanceof NonRetryableError is true", async () => {
  await assert.rejects(
    () => ssrfSafeFetch("http://169.254.169.254/"),
    (error: unknown) => {
      assert.ok(error instanceof SsrfBlockedError);
      assert.ok(error instanceof NonRetryableError);
      return true;
    },
  );
});

test("assertUrlAllowed: rejection message for a blocked URL does not leak the resolved IP or matched rule", async () => {
  await assert.rejects(
    () => assertUrlAllowed("http://169.254.169.254/"),
    (error: unknown) => {
      assert.ok(error instanceof SsrfBlockedError);
      const message = (error as Error).message;
      assert.ok(!message.includes("169.254.169.254"), `message leaked the resolved IP: ${message}`);
      assert.ok(!/linkLocal|private|loopback|carrierGradeNat|unspecified/i.test(message), `message leaked the matched rule: ${message}`);
      return true;
    },
  );
});
