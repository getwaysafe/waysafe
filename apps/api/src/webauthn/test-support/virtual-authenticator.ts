/**
 * A minimal, real WebAuthn authenticator, entirely in Node -- no browser.
 *
 * Registration and authentication responses are hand-built from the actual
 * wire format (CBOR attestation object, raw authenticator data, a genuine
 * ECDSA P-256 signature) and verified by the real `@simplewebauthn/server`,
 * not a stub. That's the point: a test double for the *verifier* would only
 * prove this codebase's orchestration is correct, never that the signature
 * check itself does anything. Using the actual verification library against
 * a genuine (if synthetic) authenticator proves both.
 *
 * Built from `@simplewebauthn/server/helpers`'s own CBOR/base64url/Uint8Array
 * utilities rather than a separate CBOR dependency, so encoding is
 * guaranteed byte-compatible with what the library decodes.
 */

import { createHash, generateKeyPairSync, randomBytes, sign as signWithKey, type KeyObject } from "node:crypto";
import { isoBase64URL, isoCBOR, isoUint8Array } from "@simplewebauthn/server/helpers";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";

/** Node's Buffer-returning APIs type as Uint8Array<ArrayBufferLike>; the
 * library's helpers want Uint8Array<ArrayBuffer>. Copying via Uint8Array.from
 * both normalizes the type and guarantees a plain (non-shared) buffer. */
function freshBytes(input: Uint8Array): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(input);
}

export interface VirtualAuthenticator {
  credentialId: Uint8Array<ArrayBuffer>;
  privateKey: KeyObject;
  publicKeyJwk: { x: string; y: string };
  /** The authenticator's own signature counter. Advances on each authentication. */
  counter: number;
}

export function createVirtualAuthenticator(): VirtualAuthenticator {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as unknown as { x: string; y: string };
  return {
    credentialId: freshBytes(randomBytes(16)),
    privateKey,
    publicKeyJwk: { x: jwk.x, y: jwk.y },
    counter: 0,
  };
}

function rpIdHash(rpId: string): Uint8Array<ArrayBuffer> {
  return freshBytes(createHash("sha256").update(rpId).digest());
}

function flagsByte(opts: { userVerified: boolean; attestedCredentialData: boolean }): Uint8Array<ArrayBuffer> {
  let flags = 0x01; // user present
  if (opts.userVerified) flags |= 0x04;
  if (opts.attestedCredentialData) flags |= 0x40;
  return new Uint8Array([flags]);
}

function uint32BE(value: number): Uint8Array<ArrayBuffer> {
  const buf = new Uint8Array(4);
  new DataView(buf.buffer).setUint32(0, value, false);
  return buf;
}

function uint16BE(value: number): Uint8Array<ArrayBuffer> {
  const buf = new Uint8Array(2);
  new DataView(buf.buffer).setUint16(0, value, false);
  return buf;
}

/** COSE_Key for an EC2 P-256 key, CBOR-encoded -- kty=EC2(2), alg=ES256(-7), crv=P-256(1). */
function buildCoseP256PublicKey(jwk: { x: string; y: string }): Uint8Array<ArrayBuffer> {
  const cose = new Map<number, number | Uint8Array>([
    [1, 2],
    [3, -7],
    [-1, 1],
    [-2, freshBytes(isoBase64URL.toBuffer(jwk.x))],
    [-3, freshBytes(isoBase64URL.toBuffer(jwk.y))],
  ]);
  return freshBytes(isoCBOR.encode(cose));
}

function clientDataJSONBytes(
  type: "webauthn.create" | "webauthn.get",
  challenge: string,
  origin: string,
): Uint8Array<ArrayBuffer> {
  return freshBytes(isoUint8Array.fromUTF8String(JSON.stringify({ type, challenge, origin, crossOrigin: false })));
}

export interface CeremonyContext {
  authenticator: VirtualAuthenticator;
  rpId: string;
  origin: string;
  /** base64url. For an authentication ceremony over a mandate, this is
   * base64url(policyHash) -- the whole point of D-20. */
  challenge: string;
}

export function buildRegistrationResponse(ctx: CeremonyContext): RegistrationResponseJSON {
  const { authenticator, rpId, origin, challenge } = ctx;

  const authData = freshBytes(
    isoUint8Array.concat([
      rpIdHash(rpId),
      flagsByte({ userVerified: true, attestedCredentialData: true }),
      uint32BE(authenticator.counter),
      new Uint8Array(16), // aaguid: zeroed, no metadata to report for a synthetic authenticator
      uint16BE(authenticator.credentialId.byteLength),
      freshBytes(authenticator.credentialId),
      buildCoseP256PublicKey(authenticator.publicKeyJwk),
    ]),
  );

  const attestationObject = freshBytes(
    isoCBOR.encode(
      new Map<string, string | Uint8Array | Map<number, number | Uint8Array>>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData],
      ]),
    ),
  );

  const clientDataJSON = clientDataJSONBytes("webauthn.create", challenge, origin);

  return {
    id: isoBase64URL.fromBuffer(freshBytes(authenticator.credentialId)),
    rawId: isoBase64URL.fromBuffer(freshBytes(authenticator.credentialId)),
    response: {
      clientDataJSON: isoBase64URL.fromBuffer(clientDataJSON),
      attestationObject: isoBase64URL.fromBuffer(attestationObject),
    },
    clientExtensionResults: {},
    type: "public-key",
  };
}

export interface AuthenticationCeremonyOptions extends CeremonyContext {
  /** Overrides the counter actually signed over. Defaults to counter + 1
   * (a real authenticator always advances). Set explicitly to construct a
   * non-incrementing (cloned-authenticator) response for negative tests. */
  signedCounter?: number;
  /** Overrides the private key used to sign, to construct a
   * signed-by-the-wrong-key response for negative tests. */
  signWithKeyOverride?: KeyObject;
}

export function buildAuthenticationResponse(opts: AuthenticationCeremonyOptions): AuthenticationResponseJSON {
  const { authenticator, rpId, origin, challenge } = opts;
  const counter = opts.signedCounter ?? authenticator.counter + 1;

  const authData = freshBytes(
    isoUint8Array.concat([
      rpIdHash(rpId),
      flagsByte({ userVerified: true, attestedCredentialData: false }),
      uint32BE(counter),
    ]),
  );

  const clientDataJSON = clientDataJSONBytes("webauthn.get", challenge, origin);
  const clientDataHash = freshBytes(createHash("sha256").update(clientDataJSON).digest());
  const signedData = freshBytes(isoUint8Array.concat([authData, clientDataHash]));
  const signature = freshBytes(
    signWithKey("sha256", Buffer.from(signedData), opts.signWithKeyOverride ?? authenticator.privateKey),
  );

  return {
    id: isoBase64URL.fromBuffer(freshBytes(authenticator.credentialId)),
    rawId: isoBase64URL.fromBuffer(freshBytes(authenticator.credentialId)),
    response: {
      clientDataJSON: isoBase64URL.fromBuffer(clientDataJSON),
      authenticatorData: isoBase64URL.fromBuffer(authData),
      signature: isoBase64URL.fromBuffer(signature),
    },
    clientExtensionResults: {},
    type: "public-key",
  };
}
