/**
 * Fetching a URL the caller chose, safely -- D-75.
 *
 * `POST /v1/enforcement/x402` takes a `resource_url` from an agent and
 * Waysafe's own server fetches it. That fetch is load-bearing: D-40 made it
 * the reason an agent cannot assert its own payment requirements, and
 * `merchant.ts` treats the result as rail-attested *because* Waysafe placed
 * the call. Before D-75 nothing checked where the call went, so any holder
 * of an agent API key could point the server at cloud instance metadata, a
 * loopback admin port, or any private-range host.
 *
 * Two properties matter here, and only one of them is the obvious one.
 *
 * **Checking the hostname is not the control.** A hostname check happens
 * before the connection, and DNS can answer differently the second time
 * ("DNS rebinding"): public at check time, `169.254.169.254` at connect
 * time. The control is that the name is resolved **once**, every returned
 * address is classified, and the connection is then **pinned** to the
 * address that was actually checked -- via Node's `lookup` hook, so the
 * socket cannot resolve the name again. TLS still validates against the
 * hostname, so pinning does not weaken certificate checking.
 *
 * **Redirects are not followed automatically.** A host that passes the
 * policy can answer `302 Location: http://169.254.169.254/`, which is why
 * an allowlist on the submitted URL would not be enough on its own. Each
 * hop is re-validated by the same policy, up to `maxRedirects`.
 *
 * The policy is an explicit argument, never a module-level default. Tests
 * pass a policy that permits loopback; production passes one that does not.
 * The code path is identical -- only the policy differs -- so a test cannot
 * accidentally prove something about a path production does not run.
 */

import { request as httpRequest } from "node:http";
import { request as httpsRequest, type RequestOptions } from "node:https";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIPv4, isIPv6 } from "node:net";

export type AddressClass =
  | "public"
  | "loopback"
  | "link-local"
  | "private"
  | "carrier-grade-nat"
  | "unique-local"
  | "multicast"
  | "unspecified"
  | "broadcast"
  | "unparseable";

export interface ResourceFetchPolicy {
  /** Exact scheme strings, including the colon. Production: `["https:"]`. */
  readonly allowedSchemes: readonly string[];
  /**
   * Exactly which address classes may be connected to. An explicit list,
   * not a boolean: the first version of this was
   * `allowPrivateAddresses: boolean`, and setting it for the demo would
   * have permitted `169.254.169.254` along with loopback, which is the
   * single most valuable SSRF target there is. A list means the local
   * policy can permit loopback and nothing else.
   */
  readonly allowedAddressClasses: readonly AddressClass[];
  /** Hops permitted after the first response. Each one is re-validated. */
  readonly maxRedirects: number;
  /** Wall-clock budget for the whole fetch, across every hop. */
  readonly timeoutMs: number;
  /** Bytes read before the connection is destroyed. A 402 body is small. */
  readonly maxResponseBytes: number;
}

/**
 * What the deployed API uses. HTTPS only, public addresses only.
 *
 * `allowPrivateAddresses` is false and there is no environment variable that
 * can flip *this* object -- `resourceFetchPolicyFromEnv` chooses between
 * this and the permissive policy, and the permissive one requires
 * `WAYSAFE_ENABLE_DEMO_ROUTES=1`, which no deployed environment sets.
 */
export const PRODUCTION_RESOURCE_FETCH_POLICY: ResourceFetchPolicy = {
  allowedSchemes: ["https:"],
  allowedAddressClasses: ["public"],
  maxRedirects: 3,
  timeoutMs: 5_000,
  maxResponseBytes: 64 * 1024,
};

/**
 * For local development and this repository's tests only.
 *
 * The `/demo`, `/film` and `/proof` flows pay a real x402 merchant that runs
 * on `127.0.0.1:4402` (`examples/demo-merchant.ts`), so they genuinely need
 * loopback. Plain HTTP is permitted for the same reason. Everything else --
 * one DNS resolution, address pinning, redirect re-validation, the timeout,
 * the size cap -- is unchanged, because those are the parts that must not
 * differ between what the tests exercise and what production runs.
 */
export const LOCAL_RESOURCE_FETCH_POLICY: ResourceFetchPolicy = {
  allowedSchemes: ["https:", "http:"],
  // Loopback and nothing else. Link-local (so instance metadata), RFC1918,
  // CGNAT, unique-local and multicast stay refused even here.
  allowedAddressClasses: ["public", "loopback"],
  maxRedirects: 3,
  timeoutMs: 5_000,
  maxResponseBytes: 64 * 1024,
};

/**
 * The policy this process will use.
 *
 * Tied to `WAYSAFE_ENABLE_DEMO_ROUTES`, deliberately, rather than given its
 * own variable. That flag already exists, is already documented as
 * development-only, and the demo merchant on loopback is the only reason
 * loopback is ever needed. One flag is easier to audit than two, and it
 * means "this deployment serves the demo routes" and "this deployment will
 * fetch private addresses" cannot drift apart. The coupling is intentional
 * and is recorded in DECISIONS.md D-75.
 */
export function resourceFetchPolicyFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): ResourceFetchPolicy {
  return env.WAYSAFE_ENABLE_DEMO_ROUTES === "1"
    ? LOCAL_RESOURCE_FETCH_POLICY
    : PRODUCTION_RESOURCE_FETCH_POLICY;
}

/** Why a URL was refused. The message is safe to put in a reason code. */
export class ResourceUrlNotPermittedError extends Error {
  constructor(readonly detail: string) {
    super(`the resource URL is not permitted: ${detail}`);
    this.name = "ResourceUrlNotPermittedError";
  }
}

/**
 * Classify a literal IP address.
 *
 * IPv4-mapped IPv6 (`::ffff:169.254.169.254`) is unwrapped and classified as
 * the IPv4 address it carries -- treating it as "some IPv6 address" is the
 * mistake that makes a v4 denylist useless.
 */
export function classifyAddress(ip: string): AddressClass {
  const value = ip.trim().toLowerCase().replace(/^\[|\]$/g, "");

  if (isIPv4(value)) return classifyIPv4(value);
  if (!isIPv6(value)) return "unparseable";

  // IPv4-mapped and IPv4-compatible forms: ::ffff:1.2.3.4, ::1.2.3.4
  const mapped = /^(?:::ffff:|::)((?:\d{1,3}\.){3}\d{1,3})$/.exec(value);
  if (mapped?.[1] && isIPv4(mapped[1])) return classifyIPv4(mapped[1]);
  // The same thing written in hex: ::ffff:a9fe:a9fe
  const hexMapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(value);
  if (hexMapped?.[1] && hexMapped[2]) {
    const high = Number.parseInt(hexMapped[1], 16);
    const low = Number.parseInt(hexMapped[2], 16);
    const v4 = [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
    return classifyIPv4(v4);
  }

  if (value === "::1") return "loopback";
  if (value === "::") return "unspecified";
  // fe80::/10 — link-local unicast
  if (/^fe[89ab][0-9a-f]?:/.test(value)) return "link-local";
  // fc00::/7 — unique local
  if (/^f[cd][0-9a-f]{0,2}:/.test(value)) return "unique-local";
  // ff00::/8 — multicast
  if (/^ff[0-9a-f]{2}:/.test(value)) return "multicast";
  return "public";
}

function classifyIPv4(ip: string): AddressClass {
  const parts = ip.split(".").map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return "unparseable";
  }
  const [a, b] = parts as [number, number, number, number];

  if (a === 0) return "unspecified";
  if (a === 127) return "loopback";
  if (a === 10) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  if (a === 169 && b === 254) return "link-local"; // includes 169.254.169.254
  if (a === 100 && b >= 64 && b <= 127) return "carrier-grade-nat";
  if (a >= 224 && a <= 239) return "multicast";
  if (ip === "255.255.255.255") return "broadcast";
  if (a >= 240) return "unparseable"; // reserved
  return "public";
}

export interface ResourceFetchResult {
  readonly status: number;
  readonly body: string;
  /** The URL that actually answered, after any permitted redirects. */
  readonly finalUrl: string;
  /** The IP each hop was pinned to, in order. For the evidence record. */
  readonly pinnedAddresses: readonly string[];
}

interface ValidatedTarget {
  url: URL;
  address: string;
  family: 4 | 6;
}

/**
 * Parse, classify and pin one URL, or throw `ResourceUrlNotPermittedError`.
 *
 * Every returned DNS answer must be permitted, not merely the first: a name
 * that resolves to both a public and a private address would otherwise let
 * whichever the OS happened to pick decide the outcome.
 */
async function validateTarget(
  raw: string,
  policy: ResourceFetchPolicy,
): Promise<ValidatedTarget> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ResourceUrlNotPermittedError("not a valid absolute URL");
  }

  if (!policy.allowedSchemes.includes(url.protocol)) {
    throw new ResourceUrlNotPermittedError(
      `scheme ${url.protocol} is not allowed (permitted: ${policy.allowedSchemes.join(", ")})`,
    );
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  if (!hostname) throw new ResourceUrlNotPermittedError("no hostname");

  // A literal IP needs no resolution; classify it directly.
  if (isIPv4(hostname) || isIPv6(hostname)) {
    const klass = classifyAddress(hostname);
    assertAddressAllowed(hostname, klass, policy);
    return { url, address: hostname, family: isIPv4(hostname) ? 4 : 6 };
  }

  let answers: Array<{ address: string; family: number }>;
  try {
    answers = await dnsLookup(hostname, { all: true });
  } catch {
    throw new ResourceUrlNotPermittedError(`hostname ${hostname} does not resolve`);
  }
  if (answers.length === 0) {
    throw new ResourceUrlNotPermittedError(`hostname ${hostname} resolved to nothing`);
  }

  for (const answer of answers) {
    assertAddressAllowed(answer.address, classifyAddress(answer.address), policy);
  }

  const chosen = answers[0]!;
  return {
    url,
    address: chosen.address,
    family: chosen.family === 6 ? 6 : 4,
  };
}

function assertAddressAllowed(
  address: string,
  klass: AddressClass,
  policy: ResourceFetchPolicy,
): void {
  if (policy.allowedAddressClasses.includes(klass)) return;
  throw new ResourceUrlNotPermittedError(
    `${address} is a ${klass} address, and this policy permits only ` +
      `${policy.allowedAddressClasses.join(", ")}`,
  );
}

/**
 * GET a caller-supplied URL under an explicit policy.
 *
 * Uses `node:http`/`node:https` rather than `fetch` for one reason: the
 * `lookup` hook. It is the seam that lets the connection be pinned to the
 * address that was classified, which `fetch` offers no way to do without
 * pulling in an agent implementation.
 */
export async function fetchResourceUnderPolicy(
  raw: string,
  policy: ResourceFetchPolicy,
): Promise<ResourceFetchResult> {
  const deadline = Date.now() + policy.timeoutMs;
  const pinnedAddresses: string[] = [];
  let current = raw;

  for (let hop = 0; hop <= policy.maxRedirects; hop += 1) {
    const target = await validateTarget(current, policy);
    pinnedAddresses.push(target.address);

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new ResourceUrlNotPermittedError(`timed out after ${policy.timeoutMs}ms`);
    }

    const hopResult = await requestOnce(target, policy, remaining);

    // Redirects are never followed by the http module itself; this is the
    // only place a hop happens, and the next URL goes back through
    // validateTarget above.
    if (hopResult.status >= 300 && hopResult.status < 400 && hopResult.location) {
      if (hop === policy.maxRedirects) {
        throw new ResourceUrlNotPermittedError(
          `more than ${policy.maxRedirects} redirects`,
        );
      }
      current = new URL(hopResult.location, target.url).toString();
      continue;
    }

    return {
      status: hopResult.status,
      body: hopResult.body,
      finalUrl: target.url.toString(),
      pinnedAddresses,
    };
  }

  throw new ResourceUrlNotPermittedError(`more than ${policy.maxRedirects} redirects`);
}

function requestOnce(
  target: ValidatedTarget,
  policy: ResourceFetchPolicy,
  timeoutMs: number,
): Promise<{ status: number; body: string; location?: string }> {
  const { url, address, family } = target;
  const isHttps = url.protocol === "https:";

  const options: RequestOptions = {
    // `host`/`servername` stay the hostname so TLS validates against the
    // certificate's name. Only the address resolution is pinned.
    host: url.hostname.replace(/^\[|\]$/g, ""),
    port: url.port || (isHttps ? 443 : 80),
    path: `${url.pathname}${url.search}`,
    method: "GET",
    headers: { accept: "application/json", "user-agent": "Waysafe/x402-fetcher" },
    // THE control (D-75): the socket never resolves the name again, so a
    // second DNS answer cannot move the connection somewhere else.
    lookup: (_hostname, opts, cb) => {
      if ((opts as { all?: boolean }).all === true) {
        (cb as unknown as (e: null, a: Array<{ address: string; family: number }>) => void)(
          null,
          [{ address, family }],
        );
      } else {
        (cb as unknown as (e: null, a: string, f: number) => void)(null, address, family);
      }
    },
  };

  const send = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const req = send(options, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > policy.maxResponseBytes) {
          req.destroy();
          reject(
            new ResourceUrlNotPermittedError(
              `response exceeded ${policy.maxResponseBytes} bytes`,
            ),
          );
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString("utf8"),
          location: typeof res.headers.location === "string" ? res.headers.location : undefined,
        });
      });
      res.on("error", reject);
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new ResourceUrlNotPermittedError(`timed out after ${policy.timeoutMs}ms`));
    });
    req.on("error", reject);
    req.end();
  });
}
