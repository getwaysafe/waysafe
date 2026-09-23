/**
 * The signer shape apps/api's evidence repositories actually need (D-63).
 *
 * `Signer`'s `publicKey()` returns raw bytes and is async, by design -- a
 * KMS returns bytes over a network call, and the base interface should not
 * assume otherwise. But the evidence repositories publish an SPKI base64
 * key directory and compute a `key_id` in their *constructors*, which are
 * synchronous, and `getPublicKey()`/`getKeyDirectory()` are synchronous
 * methods on `EvidenceRepository` that predate this interface.
 *
 * Rather than make those async (a change that would ripple into the
 * routes, for no behavior benefit), this narrows to the signers that can
 * also hand over their **public** half as a `KeyObject` -- which both
 * `EnvEd25519Signer` and `FakeEd25519Signer` can, because a public key is
 * safe to hand out by construction: it cannot sign anything.
 *
 * A future KMS-backed Ed25519 signer satisfies this the same way, by
 * caching its public key at construction (one API call) and exposing the
 * public half only. Nothing here needs, or can reach, the private key.
 */

import type { KeyObject } from "node:crypto";
import type { Signer } from "@waysafe/core";

export type EvidenceSigner = Signer & {
  /** The **public** half only. There is deliberately no private counterpart. */
  publicKeyObject(): KeyObject;
};
