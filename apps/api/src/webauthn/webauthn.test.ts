/**
 * Proves the crypto verification itself, using the real
 * `@simplewebauthn/server` against a hand-built virtual authenticator (see
 * test-support/virtual-authenticator.ts) -- not a fake verifier. A fake
 * would only prove this module's plumbing; this proves the actual
 * signature check rejects what it should.
 */

import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildAuthenticationResponse,
  buildRegistrationResponse,
  createVirtualAuthenticator,
} from "./test-support/virtual-authenticator.js";
import { verifyAuthentication, verifyRegistration, type WebauthnConfig } from "./webauthn.js";

const CONFIG: WebauthnConfig = { rpId: "localhost", origin: "http://localhost:3000" };
const CHALLENGE_A = Buffer.from("policy-hash-a-2222222222222222222222").toString("base64url");
const CHALLENGE_B = Buffer.from("policy-hash-b-3333333333333333333333").toString("base64url");

describe("registration", () => {
  it("verifies a genuine registration response", async () => {
    const authenticator = createVirtualAuthenticator();
    const response = buildRegistrationResponse({
      authenticator,
      rpId: CONFIG.rpId,
      origin: CONFIG.origin,
      challenge: CHALLENGE_A,
    });

    const result = await verifyRegistration(CONFIG, response, CHALLENGE_A);

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.counter).toBe(0);
    expect(result.value.credentialId).toBe(
      Buffer.from(authenticator.credentialId).toString("base64url"),
    );
    expect(result.value.publicKey.byteLength).toBeGreaterThan(0);
  });

  it("THE ATTACK: rejects a registration response signed over the wrong challenge", async () => {
    const authenticator = createVirtualAuthenticator();
    const response = buildRegistrationResponse({
      authenticator,
      rpId: CONFIG.rpId,
      origin: CONFIG.origin,
      challenge: CHALLENGE_A,
    });

    const result = await verifyRegistration(CONFIG, response, CHALLENGE_B);

    expect(result.ok).toBe(false);
  });

  it("THE ATTACK: rejects a registration response for the wrong RP ID", async () => {
    const authenticator = createVirtualAuthenticator();
    const response = buildRegistrationResponse({
      authenticator,
      rpId: "evil.example",
      origin: CONFIG.origin,
      challenge: CHALLENGE_A,
    });

    const result = await verifyRegistration(CONFIG, response, CHALLENGE_A);

    expect(result.ok).toBe(false);
  });
});

describe("authentication", () => {
  it("verifies a genuine authentication response and reports the advanced counter", async () => {
    const authenticator = createVirtualAuthenticator();
    const registration = buildRegistrationResponse({
      authenticator,
      rpId: CONFIG.rpId,
      origin: CONFIG.origin,
      challenge: CHALLENGE_A,
    });
    const registered = await verifyRegistration(CONFIG, registration, CHALLENGE_A);
    if (!registered.ok) throw new Error("unreachable");

    const response = buildAuthenticationResponse({
      authenticator,
      rpId: CONFIG.rpId,
      origin: CONFIG.origin,
      challenge: CHALLENGE_B,
    });

    const result = await verifyAuthentication(CONFIG, response, CHALLENGE_B, {
      id: registered.value.credentialId,
      publicKey: registered.value.publicKey,
      counter: registered.value.counter,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.value.newCounter).toBe(1);
  });

  it("THE ATTACK: rejects a signature over a different policy_hash than expected", async () => {
    const authenticator = createVirtualAuthenticator();
    const registration = buildRegistrationResponse({
      authenticator,
      rpId: CONFIG.rpId,
      origin: CONFIG.origin,
      challenge: CHALLENGE_A,
    });
    const registered = await verifyRegistration(CONFIG, registration, CHALLENGE_A);
    if (!registered.ok) throw new Error("unreachable");

    // The authenticator genuinely signs over CHALLENGE_A (a real, valid
    // signature) -- but the caller expected CHALLENGE_B (a different
    // mandate's policy_hash). A real signature over the wrong thing must
    // still be rejected.
    const response = buildAuthenticationResponse({
      authenticator,
      rpId: CONFIG.rpId,
      origin: CONFIG.origin,
      challenge: CHALLENGE_A,
    });

    const result = await verifyAuthentication(CONFIG, response, CHALLENGE_B, {
      id: registered.value.credentialId,
      publicKey: registered.value.publicKey,
      counter: registered.value.counter,
    });

    expect(result.ok).toBe(false);
  });

  it("THE ATTACK: rejects a signature produced by a different key than the one registered", async () => {
    const authenticator = createVirtualAuthenticator();
    const registration = buildRegistrationResponse({
      authenticator,
      rpId: CONFIG.rpId,
      origin: CONFIG.origin,
      challenge: CHALLENGE_A,
    });
    const registered = await verifyRegistration(CONFIG, registration, CHALLENGE_A);
    if (!registered.ok) throw new Error("unreachable");

    const { privateKey: forgedKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const response = buildAuthenticationResponse({
      authenticator,
      rpId: CONFIG.rpId,
      origin: CONFIG.origin,
      challenge: CHALLENGE_B,
      signWithKeyOverride: forgedKey,
    });

    const result = await verifyAuthentication(CONFIG, response, CHALLENGE_B, {
      id: registered.value.credentialId,
      publicKey: registered.value.publicKey,
      counter: registered.value.counter,
    });

    expect(result.ok).toBe(false);
  });

  it("THE ATTACK: rejects a replayed assertion whose counter did not advance", async () => {
    const authenticator = createVirtualAuthenticator();
    const registration = buildRegistrationResponse({
      authenticator,
      rpId: CONFIG.rpId,
      origin: CONFIG.origin,
      challenge: CHALLENGE_A,
    });
    const registered = await verifyRegistration(CONFIG, registration, CHALLENGE_A);
    if (!registered.ok) throw new Error("unreachable");

    // A credential whose stored counter is already 5 (from prior real use);
    // this response replays an old assertion signed with counter=3.
    const replayed = buildAuthenticationResponse({
      authenticator,
      rpId: CONFIG.rpId,
      origin: CONFIG.origin,
      challenge: CHALLENGE_B,
      signedCounter: 3,
    });

    const result = await verifyAuthentication(CONFIG, replayed, CHALLENGE_B, {
      id: registered.value.credentialId,
      publicKey: registered.value.publicKey,
      counter: 5,
    });

    expect(result.ok).toBe(false);
  });
});
