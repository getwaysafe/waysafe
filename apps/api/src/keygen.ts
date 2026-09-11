/**
 * Generates three real keypairs -- the evidence-signing key (D-26/OQ-8),
 * the x402 co-signer key (D-40), and the x402 Safe co-signer key (D-41).
 * The first two are Ed25519, from the same generic
 * `generateEvidenceSigningKeyPair` primitive, since an Ed25519 keypair is
 * an Ed25519 keypair; they're printed as two separate keys, and must stay
 * two separate keys, because they attest two different things (see
 * x402-signing-key.ts's doc comment for why). The third is genuinely a
 * different *kind* of key, secp256k1, not just a different instance of the
 * same kind -- see x402-safe.ts's file-level comment for why an Ed25519
 * key could never substitute for it (Safe owners are secp256k1 EVM
 * addresses; Ed25519 has no such address at all).
 *
 *   npm run keygen -w @waysafe/api
 *
 * The first private key is what WAYSAFE_EVIDENCE_SIGNING_KEY holds -- keep
 * it secret, out of source control, and stable across restarts (rotating
 * it invalidates verification of every signature made under the old one).
 * Its public key is what GET /v1/evidence/public-key publishes and what a
 * third party checks receipts against; safe to hand out, useless for
 * signing anything. The second is what WAYSAFE_X402_COSIGNER_KEY holds --
 * same secrecy rules, but see D-40: this key has no on-chain counterpart to
 * verify against -- it signs an off-chain decision attestation only. The
 * third is what WAYSAFE_SAFE_COSIGNER_KEY holds: same secrecy rules again,
 * but this one *is* load-bearing on-chain (D-41) -- it must be a permanent
 * owner of every mandate's deployed Safe, so rotating it strands every Safe
 * that already named the old address as an owner.
 */
import { exportPrivateKeyBase64, exportPublicKeyBase64, generateEvidenceSigningKeyPair } from "@waysafe/core";
import { generatePrivateKey, privateKeyToAddress } from "viem/accounts";

const evidence = generateEvidenceSigningKeyPair();
const x402 = generateEvidenceSigningKeyPair();
const safeCosigner = generatePrivateKey();

console.log("# Add this to your .env -- keep it secret:");
console.log(`WAYSAFE_EVIDENCE_SIGNING_KEY="${exportPrivateKeyBase64(evidence.privateKey)}"`);
console.log();
console.log("# The corresponding public key (also served at GET /v1/evidence/public-key):");
console.log(`# ${exportPublicKeyBase64(evidence.publicKey)}`);
console.log();
console.log("# A separate key for the x402 enforcement co-signer (D-40) -- add this too:");
console.log(`WAYSAFE_X402_COSIGNER_KEY="${exportPrivateKeyBase64(x402.privateKey)}"`);
console.log();
console.log("# Its public key (no publishing endpoint yet -- an off-chain attestation only, D-40):");
console.log(`# ${exportPublicKeyBase64(x402.publicKey)}`);
console.log();
console.log("# secp256k1, not Ed25519 -- deliberately (D-41): this is a Safe owner's EVM key, add it too:");
console.log(`WAYSAFE_SAFE_COSIGNER_KEY="${safeCosigner}"`);
console.log();
console.log("# Its EVM address -- this is the one that must be named as a Safe owner on-chain:");
console.log(`# ${privateKeyToAddress(safeCosigner)}`);
