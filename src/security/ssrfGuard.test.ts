import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import dnsPromises from "node:dns/promises";
import { NonRetryableError } from "../errors";
import { assertUrlAllowed, resolveAndValidate, ssrfSafeFetch, SsrfBlockedError } from "./ssrfGuard";

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

test("ssrfSafeFetch: a redirect to a blocked address is rejected (the connect hook, not just a pre-check, does the work)", async () => {
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
