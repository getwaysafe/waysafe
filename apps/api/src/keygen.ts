/**
 * Generates two real Ed25519 keypairs -- the evidence-signing key (D-26/
 * OQ-8) and the x402 co-signer key (D-40) -- both from the same generic
 * `generateEvidenceSigningKeyPair` primitive, since an Ed25519 keypair is
 * an Ed25519 keypair; they're printed as two separate keys, and must stay
 * two separate keys, because they attest two different things (see
 * x402-signing-key.ts's doc comment for why).
 *
 *   npm run keygen -w @waysafe/api
 *
 * The first private key is what WAYSAFE_EVIDENCE_SIGNING_KEY holds -- keep
 * it secret, out of source control, and stable across restarts (rotating
 * it invalidates verification of every signature made under the old one).
 * Its public key is what GET /v1/evidence/public-key publishes and what a
 * third party checks receipts against; safe to hand out, useless for
 * signing anything. The second is what WAYSAFE_X402_COSIGNER_KEY holds --
 * same secrecy rules, but see D-40: until a real 2-of-2 payer-account
 * design is built, this key has no on-chain counterpart to verify against.
 */
import { exportPrivateKeyBase64, exportPublicKeyBase64, generateEvidenceSigningKeyPair } from "@waysafe/core";

const evidence = generateEvidenceSigningKeyPair();
const x402 = generateEvidenceSigningKeyPair();

console.log("# Add this to your .env -- keep it secret:");
console.log(`WAYSAFE_EVIDENCE_SIGNING_KEY="${exportPrivateKeyBase64(evidence.privateKey)}"`);
console.log();
console.log("# The corresponding public key (also served at GET /v1/evidence/public-key):");
console.log(`# ${exportPublicKeyBase64(evidence.publicKey)}`);
console.log();
console.log("# A separate key for the x402 enforcement co-signer (D-40) -- add this too:");
console.log(`WAYSAFE_X402_COSIGNER_KEY="${exportPrivateKeyBase64(x402.privateKey)}"`);
console.log();
console.log("# Its public key (no publishing endpoint yet -- no on-chain counterpart exists):");
console.log(`# ${exportPublicKeyBase64(x402.publicKey)}`);
