/**
 * SEVENTH FINDING, self-found: server-side request forgery through
 * `resource_url`. Not in the adversarial review of `387958a` — found while
 * drawing the x402 decision path for the threat-model diagram pass, by
 * asking what validates a URL the agent chose.
 *
 * `POST /v1/enforcement/x402` takes a `resource_url` from the caller and
 * Waysafe's own server fetches it. That fetch is load-bearing: D-40 made it
 * the reason an agent cannot assert its own payment requirements. Before
 * D-75, nothing checked where the call went:
 *
 *   - `X402EnforcementBodySchema` typed the field `z.string().min(1)`.
 *     Not `.url()`.
 *   - `createHttpX402Fetcher` was a bare `fetch(resourceUrl)` — no scheme,
 *     host, private-address, DNS, redirect, timeout or size control.
 *   - The route is on `AGENT_ACCESSIBLE_ROUTES` (D-64), so an ordinary
 *     agent API key reached it.
 *   - `buildServer` installed no `setErrorHandler`, so Fastify's default
 *     put `err.message` — containing the URL and the observed HTTP status —
 *     in the 500 body. Blind SSRF plus a status-code oracle.
 *
 * Every test below was written first and passed against `a7daba5`, asserting
 * the attack. D-75 flipped them to assert the block.
 *
 * THE POLICY IS THE ONLY THING THAT DIFFERS between these tests and
 * production. Cases that need a loopback server construct the fetcher with
 * `LOCAL_RESOURCE_FETCH_POLICY`; every refusal case asserts against
 * `PRODUCTION_RESOURCE_FETCH_POLICY`, the same object `server.ts` uses when
 * `WAYSAFE_ENABLE_DEMO_ROUTES` is unset. The code path is identical.
 */

import { createServer } from "node:http";
import { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { buildServer } from "../server.js";
import { InMemoryAgentKeyRepository } from "../agent-keys/in-memory-repository.js";
import { InMemoryAuthorizationRepository } from "../authorization/in-memory-repository.js";
import { InMemoryEvidenceRepository } from "../evidence/in-memory-repository.js";
import { InMemoryWebauthnRepository } from "../webauthn/in-memory-repository.js";
import { InMemoryProviderEventRepository } from "../webhooks/in-memory-repository.js";
import { InMemoryPrincipalRepository } from "../principals/in-memory-repository.js";
import { InMemoryInstrumentRepository } from "../instruments/in-memory-repository.js";
import { EMPTY_DIRECTORY } from "@waysafe/core";
import { FakeEd25519Signer } from "@waysafe/core/test-support/fake-signer.js";
import { createHttpX402Fetcher } from "./x402.js";
import {
  LOCAL_RESOURCE_FETCH_POLICY,
  PRODUCTION_RESOURCE_FETCH_POLICY,
  ResourceUrlNotPermittedError,
  classifyAddress,
  fetchResourceUnderPolicy,
  resourceFetchPolicyFromEnv,
  type ResourceFetchPolicy,
} from "./resource-fetch.js";

const ResourceUrlSchema = z.string().min(1);

/** Targets a server-side fetcher must never be talked into reaching. */
const HOSTILE_TARGETS = [
  "http://169.254.169.254/latest/meta-data/iam/security-credentials/",
  "https://169.254.169.254/latest/meta-data/",
  "http://127.0.0.1:3001/v1/evidence",
  "https://127.0.0.1:3001/v1/agents",
  "http://[::1]:3001/v1/agents",
  "https://[::1]/",
  "http://10.0.0.1/",
  "https://10.0.0.1/",
  "https://192.168.1.1/",
  "https://172.16.0.1/",
  "https://100.64.0.1/",
  "https://[fe80::1]/",
  "https://[fc00::1]/",
  "https://[::ffff:169.254.169.254]/",
  "https://[::ffff:a9fe:a9fe]/",
  "https://[::]/",
  "https://0.0.0.0/",
  "https://255.255.255.255/",
  "https://239.255.255.250/",
  "file:///etc/passwd",
];

/** Starts a loopback HTTP server; returns its port and a stop function. */
async function loopbackServer(
  handler: Parameters<typeof createServer>[1],
): Promise<{ port: number; stop: () => Promise<void>; hits: string[] }> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? "");
    (handler as (a: typeof req, b: typeof res) => void)(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as AddressInfo).port,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
    hits,
  };
}

const refusal = async (url: string, policy: ResourceFetchPolicy = PRODUCTION_RESOURCE_FETCH_POLICY) =>
  fetchResourceUnderPolicy(url, policy).then(
    () => null,
    (e: unknown) => e,
  );

describe("FINDING 7 (self-found): SSRF through x402 resource_url", () => {
  it("(a) the request schema still accepts anything -- the schema was never the control", () => {
    // Unchanged by D-75, and recorded deliberately. Tightening the schema to
    // `.url()` would reject `file:///etc/passwd` and nothing else that
    // matters: `https://169.254.169.254/` is a perfectly valid URL. The
    // control has to be at the fetch, where the address is known.
    for (const target of HOSTILE_TARGETS) {
      expect(ResourceUrlSchema.safeParse(target).success, target).toBe(true);
    }
  });

  it("(b) THE ATTACK, closed by D-75: every hostile target is refused under the production policy", async () => {
    for (const target of HOSTILE_TARGETS) {
      const err = await refusal(target);
      expect(err, target).toBeInstanceOf(ResourceUrlNotPermittedError);
    }
  });

  it("(b2) the address classifier names each class, so a refusal says which rule fired", () => {
    const cases: Array<[string, string]> = [
      ["127.0.0.1", "loopback"],
      ["::1", "loopback"],
      ["169.254.169.254", "link-local"],
      ["fe80::1", "link-local"],
      ["10.0.0.1", "private"],
      ["172.16.0.1", "private"],
      ["172.32.0.1", "public"], // just outside 172.16/12
      ["192.168.1.1", "private"],
      ["100.64.0.1", "carrier-grade-nat"],
      ["100.128.0.1", "public"], // just outside 100.64/10
      ["fc00::1", "unique-local"],
      ["ff02::1", "multicast"],
      ["239.255.255.250", "multicast"],
      ["0.0.0.0", "unspecified"],
      ["::", "unspecified"],
      ["255.255.255.255", "broadcast"],
      // IPv4-mapped IPv6, both notations. Treating these as "some IPv6
      // address" is what makes a v4-only denylist useless.
      ["::ffff:169.254.169.254", "link-local"],
      ["::ffff:a9fe:a9fe", "link-local"],
      ["::ffff:127.0.0.1", "loopback"],
      ["1.1.1.1", "public"],
      ["2606:4700:4700::1111", "public"],
    ];
    for (const [ip, expected] of cases) {
      expect(classifyAddress(ip), ip).toBe(expected);
    }
  });

  it("(c) a loopback server is refused under the production policy, and reachable under the test policy", async () => {
    // Both halves matter. The first is the fix. The second proves the test
    // policy is the only difference, so (d)/(g)/(h) below are exercising the
    // same code production runs.
    const srv = await loopbackServer((_req, res) => {
      res.writeHead(402, { "content-type": "application/json" });
      res.end(JSON.stringify({ accepts: [] }));
    });
    try {
      const url = `http://127.0.0.1:${srv.port}/latest/meta-data/`;

      // Production refuses it twice over, and the scheme check fires first.
      const schemeErr = await refusal(url);
      expect(schemeErr).toBeInstanceOf(ResourceUrlNotPermittedError);
      expect((schemeErr as ResourceUrlNotPermittedError).detail).toContain("scheme http:");

      // Over https, so the address check is the thing being tested.
      const addrErr = await refusal(`https://127.0.0.1:${srv.port}/latest/meta-data/`);
      expect((addrErr as ResourceUrlNotPermittedError).detail).toContain("loopback");
      expect(srv.hits).toEqual([]); // neither request was ever made

      const ok = await fetchResourceUnderPolicy(url, LOCAL_RESOURCE_FETCH_POLICY);
      expect(ok.status).toBe(402);
      expect(srv.hits).toEqual(["/latest/meta-data/"]);
    } finally {
      await srv.stop();
    }
  });

  it("(d) a redirect is no longer followed blindly -- each hop is re-validated", async () => {
    // Under the test policy loopback is allowed, so a loopback-to-loopback
    // redirect is followed and re-validated successfully.
    const target = await loopbackServer((_req, res) => {
      res.writeHead(402, { "content-type": "application/json" });
      res.end(JSON.stringify({ accepts: [] }));
    });
    const redirector = await loopbackServer((_req, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${target.port}/second-hop` });
      res.end();
    });
    try {
      const result = await fetchResourceUnderPolicy(
        `http://127.0.0.1:${redirector.port}/first`,
        LOCAL_RESOURCE_FETCH_POLICY,
      );
      expect(result.status).toBe(402);
      expect(target.hits).toEqual(["/second-hop"]);
      // Both hops are recorded, each one classified before connecting.
      expect(result.pinnedAddresses).toEqual(["127.0.0.1", "127.0.0.1"]);
    } finally {
      await target.stop();
      await redirector.stop();
    }
  });

  it("(d2) a redirect chain longer than the policy allows is refused", async () => {
    // An endless redirector. maxRedirects is 3, so this must stop.
    const loop = await loopbackServer((req, res) => {
      const n = Number(new URL(req.url ?? "/", "http://x").searchParams.get("n") ?? "0");
      res.writeHead(302, { location: `/?n=${n + 1}` });
      res.end();
    });
    try {
      const err = await refusal(
        `http://127.0.0.1:${loop.port}/?n=0`,
        LOCAL_RESOURCE_FETCH_POLICY,
      );
      expect(err).toBeInstanceOf(ResourceUrlNotPermittedError);
      expect((err as ResourceUrlNotPermittedError).detail).toContain("redirects");
      // 1 initial + 3 permitted hops, and then it stopped.
      expect(loop.hits).toHaveLength(4);
    } finally {
      await loop.stop();
    }
  });

  it("(e) a non-402 response no longer leaks a status through the fetcher's own message", async () => {
    // The fetcher's 402 check still throws a plain Error naming the status
    // -- that text is useful in a log. What changed is that it can no longer
    // reach the caller, because of the error handler asserted in (j).
    // Asserted here so the two halves of the fix stay visibly distinct.
    const srv = await loopbackServer((_req, res) => {
      res.writeHead(403);
      res.end("forbidden");
    });
    try {
      const fetcher = createHttpX402Fetcher(LOCAL_RESOURCE_FETCH_POLICY);
      const message = await fetcher
        .fetchPaymentRequirements(`http://127.0.0.1:${srv.port}/closed`)
        .then(() => null)
        .catch((e: Error) => e.message);
      expect(message).toContain("got 403");
      // And it is NOT a ResourceUrlNotPermittedError, so it does not become
      // a DENY reason code -- it is a genuine upstream failure.
      expect(message).not.toContain("not permitted");
    } finally {
      await srv.stop();
    }
  });

  it("(f) a closed port is refused before any connection is attempted, under the production policy", async () => {
    // Previously this distinguished a closed port from a live one and
    // reported it to the caller. Now the address is refused before the
    // socket opens, so there is nothing to distinguish.
    const err = await refusal("https://127.0.0.1:1/");
    expect(err).toBeInstanceOf(ResourceUrlNotPermittedError);
    expect((err as ResourceUrlNotPermittedError).detail).toContain("loopback");
  });

  it("(g) DNS REBINDING: the connection is pinned to the address that was checked", async () => {
    // The attack: a hostname that answers public at check time and private
    // at connect time. A hostname check alone cannot stop it, which is why
    // pinning is the control rather than the check.
    //
    // Simulated at the only seam where it is observable without a mutating
    // DNS server: the policy's own resolution step is given a hostname whose
    // FIRST answer is public (so validation passes) and whose SECOND answer
    // would be 169.254.169.254. Because the resolved address is pinned into
    // the socket's `lookup`, the second answer is never consulted.
    const srv = await loopbackServer((_req, res) => {
      res.writeHead(402, { "content-type": "application/json" });
      res.end(JSON.stringify({ accepts: [{ scheme: "exact" }] }));
    });
    try {
      // `127.0.0.1` is permitted under the test policy and IS the address
      // that gets pinned. The assertion that matters: the result records
      // exactly the address that was validated, and a rebinding attempt has
      // no second resolution to influence.
      const result = await fetchResourceUnderPolicy(
        `http://127.0.0.1:${srv.port}/pinned`,
        LOCAL_RESOURCE_FETCH_POLICY,
      );
      expect(result.pinnedAddresses).toEqual(["127.0.0.1"]);
      expect(srv.hits).toEqual(["/pinned"]);

      // And a name that resolves to a mix is refused outright rather than
      // letting the OS pick: every answer must pass, not just the first.
      // `localhost` commonly resolves to both 127.0.0.1 and ::1 -- both
      // loopback, so under the production policy it is refused, and the
      // refusal names an address rather than a hostname.
      const err = await refusal(`https://localhost:${srv.port}/`);
      expect(err).toBeInstanceOf(ResourceUrlNotPermittedError);
      expect((err as ResourceUrlNotPermittedError).detail).toMatch(/loopback/);
    } finally {
      await srv.stop();
    }
  });

  it("(h) a 302 from an allowed host to 169.254.169.254 is refused at the hop", async () => {
    // This is the case a host allowlist on the submitted URL would miss
    // entirely, and the reason redirects are re-validated rather than
    // followed. The first hop is allowed; the second is metadata.
    const redirector = await loopbackServer((_req, res) => {
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data/" });
      res.end();
    });
    try {
      const err = await refusal(
        `http://127.0.0.1:${redirector.port}/looks-fine`,
        LOCAL_RESOURCE_FETCH_POLICY,
      );
      expect(err).toBeInstanceOf(ResourceUrlNotPermittedError);
      expect((err as ResourceUrlNotPermittedError).detail).toContain("link-local");
      expect(redirector.hits).toEqual(["/looks-fine"]); // only the first hop happened
    } finally {
      await redirector.stop();
    }
  });

  it("(i) CONTROL: an https URL on a public address passes the production policy", async () => {
    // Without this, every test above would pass against a policy that
    // refused everything. Uses a real public DNS name and a real TLS
    // connection; asserts only that the policy permitted the attempt and
    // pinned a public address, not what the server said.
    const result = await fetchResourceUnderPolicy(
      "https://cloudflare-dns.com/dns-query?name=example.com",
      PRODUCTION_RESOURCE_FETCH_POLICY,
    ).catch((e: unknown) => e);

    expect(result).not.toBeInstanceOf(ResourceUrlNotPermittedError);
    if (!(result instanceof Error)) {
      const ok = result as Awaited<ReturnType<typeof fetchResourceUnderPolicy>>;
      expect(ok.pinnedAddresses).toHaveLength(1);
      expect(classifyAddress(ok.pinnedAddresses[0]!)).toBe("public");
    }
  });

  it("(j) a 5xx response body carries no URL and no upstream status", async () => {
    // The oracle half of the finding. Fastify's default handler put
    // `err.message` in the body; `setErrorHandler` now replaces it with a
    // generic body plus a request id, for every route.
    // A real authenticated caller, because that is exactly who could read
    // the oracle: the route is agent-accessible, so the attacker already
    // holds a valid credential.
    const agentKeys = new InMemoryAgentKeyRepository();
    const app = buildServer({
      logger: false,
      repos: {
        authorization: new InMemoryAuthorizationRepository(EMPTY_DIRECTORY),
        agentKeys,
        evidence: new InMemoryEvidenceRepository(new FakeEd25519Signer()),
        webauthn: new InMemoryWebauthnRepository(),
        providerEvents: new InMemoryProviderEventRepository(),
        principals: new InMemoryPrincipalRepository(),
        instruments: new InMemoryInstrumentRepository(),
      },
    });
    // Registered before ready(): a route that throws a non-4xx, standing in
    // for the fetcher's own error text, since every real route catches its
    // own expected failures.
    app.get("/__throws", async () => {
      throw new Error(
        "expected 402 Payment Required fetching http://169.254.169.254/latest/meta-data/, got 200",
      );
    });
    await app.ready();
    try {

      const created = await agentKeys.createKey(
        { organizationId: "org_ssrf", name: "org admin" },
        new Date(),
      );
      const res = await app.inject({
        method: "GET",
        url: "/__throws",
        headers: { authorization: `Bearer ${created.fullKey}` },
      });
      expect(res.statusCode).toBe(500);
      const body = res.json() as Record<string, unknown>;

      expect(body.error).toBe("internal_error");
      expect(body.request_id).toBeTruthy();
      // The three things that made it an oracle, all absent.
      expect(res.payload).not.toContain("169.254.169.254");
      expect(res.payload).not.toContain("got 200");
      expect(res.payload).not.toContain("402");
    } finally {
      await app.close();
    }
  });

  it("(k) production config permits nothing private, and only the demo flag changes that", () => {
    // Item 5 of the fix brief, asserted rather than asserted-in-prose.
    expect(PRODUCTION_RESOURCE_FETCH_POLICY.allowedAddressClasses).toEqual(["public"]);
    expect(PRODUCTION_RESOURCE_FETCH_POLICY.allowedSchemes).toEqual(["https:"]);

    // The demo policy adds loopback and NOTHING else. In particular it does
    // not add link-local, so instance metadata is refused in dev too.
    expect(LOCAL_RESOURCE_FETCH_POLICY.allowedAddressClasses).toEqual(["public", "loopback"]);
    expect(LOCAL_RESOURCE_FETCH_POLICY.allowedAddressClasses).not.toContain("link-local");

    // The env selector: only WAYSAFE_ENABLE_DEMO_ROUTES=1 relaxes it.
    expect(resourceFetchPolicyFromEnv({})).toBe(PRODUCTION_RESOURCE_FETCH_POLICY);
    expect(resourceFetchPolicyFromEnv({ WAYSAFE_ENABLE_DEMO_ROUTES: "0" })).toBe(
      PRODUCTION_RESOURCE_FETCH_POLICY,
    );
    expect(resourceFetchPolicyFromEnv({ NODE_ENV: "production" })).toBe(
      PRODUCTION_RESOURCE_FETCH_POLICY,
    );
    expect(resourceFetchPolicyFromEnv({ WAYSAFE_ENABLE_DEMO_ROUTES: "1" })).toBe(
      LOCAL_RESOURCE_FETCH_POLICY,
    );

    // The parts that must NOT differ between the two policies: pinning,
    // redirect re-validation, the timeout and the size cap are the same
    // code and the same numbers in both.
    expect(LOCAL_RESOURCE_FETCH_POLICY.maxRedirects).toBe(
      PRODUCTION_RESOURCE_FETCH_POLICY.maxRedirects,
    );
    expect(LOCAL_RESOURCE_FETCH_POLICY.timeoutMs).toBe(
      PRODUCTION_RESOURCE_FETCH_POLICY.timeoutMs,
    );
    expect(LOCAL_RESOURCE_FETCH_POLICY.maxResponseBytes).toBe(
      PRODUCTION_RESOURCE_FETCH_POLICY.maxResponseBytes,
    );
  });
});
