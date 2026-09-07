/**
 * Generates a real Ed25519 evidence-signing keypair (D-26/OQ-8).
 *
 *   npm run keygen -w @waysafe/api
 *
 * The private key is what WAYSAFE_EVIDENCE_SIGNING_KEY holds -- keep it
 * secret, out of source control, and stable across restarts (rotating it
 * invalidates verification of every signature made under the old one). The
 * public key is what GET /v1/evidence/public-key publishes and what a third
 * party checks receipts against; safe to hand out, useless for signing
 * anything.
 */
import { exportPrivateKeyBase64, exportPublicKeyBase64, generateEvidenceSigningKeyPair } from "@waysafe/core";

const { privateKey, publicKey } = generateEvidenceSigningKeyPair();

console.log("# Add this to your .env -- keep it secret:");
console.log(`WAYSAFE_EVIDENCE_SIGNING_KEY="${exportPrivateKeyBase64(privateKey)}"`);
console.log();
console.log("# The corresponding public key (also served at GET /v1/evidence/public-key):");
console.log(`# ${exportPublicKeyBase64(publicKey)}`);
