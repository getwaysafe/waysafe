/**
 * EnvSigner's own tests (D-63). The central claim under test is that this
 * refactor changed *where the key lives in the code* and nothing else:
 * every signature it produces must be byte-identical to one produced the
 * old way, with the raw key, for both algorithms.
 */

import { describe, expect, it, vi } from "vitest";
import { createPrivateKey, createPublicKey, sign as nodeSign, verify } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import {
  computeKeyId,
  exportPrivateKeyBase64,
  exportPublicKeyBase64,
  generateEvidenceSigningKeyPair,
  signEventHash,
  verifyEventSignature,
} from "@waysafe/core";
import { EnvEd25519Signer, EnvSecp256k1Signer } from "./env-signer.js";
import { viemAccountFor } from "./evm-account.js";

// A fixed key, so these assertions are reproducible rather than "whatever
// this run generated". Generated once for this test file and never used
// anywhere real -- it signs nothing outside this process.
const FIXED_ED25519_PKCS8_B64 = exportPrivateKeyBase64(
  createPrivateKey({
    key: Buffer.concat([
      Buffer.from("302e020100300506032b657004220420", "hex"),
      Buffer.from("a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90", "hex"),
    ]),
    format: "der",
    type: "pkcs8",
  }),
);

// Likewise fixed, and likewise never used anywhere real.
const FIXED_SECP256K1_HEX = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

/** A hex SHA-256 digest -- the shape an evidence event hash has. */
const HASH_HEX = "b".repeat(64);

describe("EnvEd25519Signer: byte-for-byte compatible with the old raw-key path (D-63)", () => {
  it("produces the identical signature bytes the old `sign(null, payload, key)` call did", async () => {
    const signer = EnvEd25519Signer.fromBase64Pkcs8(FIXED_ED25519_PKCS8_B64);
    const rawKey = createPrivateKey({
      key: Buffer.from(FIXED_ED25519_PKCS8_B64, "base64"),
      format: "der",
      type: "pkcs8",
    });
    const payload = Buffer.from("deadbeef".repeat(8), "hex");

    const viaSigner = Buffer.from(await signer.sign(payload));
    const viaOldPath = nodeSign(null, payload, rawKey);

    expect(viaSigner.equals(viaOldPath)).toBe(true);
  });

  it("an evidence-chain signature made through the Signer still verifies with the existing verifier", async () => {
    const signer = EnvEd25519Signer.fromBase64Pkcs8(FIXED_ED25519_PKCS8_B64);
    const hash = "a".repeat(64); // a hex SHA-256 digest, the shape signEventHash takes

    const viaSigner = Buffer.from(await signer.sign(Buffer.from(hash, "hex"))).toString("base64");

    // The existing, unchanged verifier -- and the existing, unchanged
    // signer -- both agree with what the Signer produced.
    expect(verifyEventSignature(signer.publicKeyObject(), hash, viaSigner)).toBe(true);
    const rawKey = createPrivateKey({
      key: Buffer.from(FIXED_ED25519_PKCS8_B64, "base64"),
      format: "der",
      type: "pkcs8",
    });
    expect(signEventHash(rawKey, hash)).toBe(viaSigner);
  });

  it("keyId equals computeKeyId of the same key -- existing evidence key_id values are unchanged", () => {
    const signer = EnvEd25519Signer.fromBase64Pkcs8(FIXED_ED25519_PKCS8_B64);
    const rawKey = createPrivateKey({
      key: Buffer.from(FIXED_ED25519_PKCS8_B64, "base64"),
      format: "der",
      type: "pkcs8",
    });
    expect(signer.keyId).toBe(computeKeyId(rawKey));
  });

  it("publishes the same SPKI public key the key directory already publishes", () => {
    const signer = EnvEd25519Signer.fromBase64Pkcs8(FIXED_ED25519_PKCS8_B64);
    const rawKey = createPrivateKey({
      key: Buffer.from(FIXED_ED25519_PKCS8_B64, "base64"),
      format: "der",
      type: "pkcs8",
    });
    expect(exportPublicKeyBase64(signer.publicKeyObject())).toBe(exportPublicKeyBase64(rawKey));
  });

  it("a generated key survives base64 PKCS8 export and reload through the Signer, and still signs verifiably", async () => {
    // The round-trip that used to live in @waysafe/core's own test, moved
    // here with D-63 because core no longer decodes a private key at all.
    const { privateKey, publicKey } = generateEvidenceSigningKeyPair();
    const signer = EnvEd25519Signer.fromBase64Pkcs8(exportPrivateKeyBase64(privateKey));
    const signature = Buffer.from(await signer.sign(Buffer.from(HASH_HEX, "hex"))).toString("base64");
    expect(verifyEventSignature(publicKey, HASH_HEX, signature)).toBe(true);
  });

  it("ephemeral() still works with no env var, same as the old loadOrGenerate fallback", async () => {
    const signer = EnvEd25519Signer.ephemeral();
    const payload = Buffer.from("ephemeral");
    const signature = await signer.sign(payload);
    expect(verify(null, payload, signer.publicKeyObject(), Buffer.from(signature))).toBe(true);
  });

  it("two ephemeral signers are different keys -- the fallback is per-instance, not shared", async () => {
    const a = EnvEd25519Signer.ephemeral();
    const b = EnvEd25519Signer.ephemeral();
    expect(a.keyId).not.toBe(b.keyId);
  });
});

describe("EnvSecp256k1Signer: byte-for-byte compatible with the old viem account path (D-63)", () => {
  it("derives the identical address privateKeyToAccount always did", async () => {
    const signer = EnvSecp256k1Signer.fromHex(FIXED_SECP256K1_HEX);
    const account = privateKeyToAccount(FIXED_SECP256K1_HEX);
    expect(await signer.address()).toBe(account.address);
  });

  it("produces the identical signature bytes the raw account's signMessage did", async () => {
    const signer = EnvSecp256k1Signer.fromHex(FIXED_SECP256K1_HEX);
    const account = privateKeyToAccount(FIXED_SECP256K1_HEX);
    const payload = Buffer.from("11".repeat(32), "hex");

    const viaSigner = Buffer.from(await signer.sign(payload)).toString("hex");
    const viaOldPath = (await account.signMessage({ message: { raw: `0x${payload.toString("hex")}` } })).slice(2);

    expect(viaSigner).toBe(viaOldPath);
  });

  it("accepts a key with or without the 0x prefix, producing the same signer", async () => {
    const withPrefix = EnvSecp256k1Signer.fromHex(FIXED_SECP256K1_HEX);
    const withoutPrefix = EnvSecp256k1Signer.fromHex(FIXED_SECP256K1_HEX.slice(2));
    expect(await withoutPrefix.address()).toBe(await withPrefix.address());
    expect(withoutPrefix.keyId).toBe(withPrefix.keyId);
  });
});

describe("EnvSigner exposes no route to the private key (D-63)", () => {
  it("has no property, accessor, or method that yields private key material", async () => {
    const signer = EnvEd25519Signer.fromBase64Pkcs8(FIXED_ED25519_PKCS8_B64);
    const names = [
      ...Object.getOwnPropertyNames(signer),
      ...Object.getOwnPropertyNames(Object.getPrototypeOf(signer)),
    ];
    expect(names).not.toContain("privateKey");

    // Nothing reachable by name is a private KeyObject.
    for (const name of names) {
      const value = (signer as unknown as Record<string, unknown>)[name];
      if (value && typeof value === "object" && "type" in (value as object)) {
        expect((value as { type: unknown }).type).not.toBe("private");
      }
    }
    // publicKeyObject exists and is genuinely public -- it cannot sign.
    expect(signer.publicKeyObject().type).toBe("public");
  });

  it("THE LEAK TEST: the private key appears nowhere in logged output, for either algorithm", async () => {
    const ed = EnvEd25519Signer.fromBase64Pkcs8(FIXED_ED25519_PKCS8_B64);
    const secp = EnvSecp256k1Signer.fromHex(FIXED_SECP256K1_HEX);

    const captured: string[] = [];
    const logSpy = vi.spyOn(console, "debug").mockImplementation((...args: unknown[]) => {
      captured.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    });

    try {
      await ed.sign(Buffer.from("payload-a"));
      await secp.sign(Buffer.from("22".repeat(32), "hex"));

      // Log the signer objects themselves, plus a realistic request context
      // holding them -- the shape a debug-level log of a handler would take.
      const requestContext = { route: "/v1/enforcement/x402", signers: { ed, secp }, attempt: 1 };
      console.debug("signer:", ed);
      console.debug("signer:", secp);
      console.debug("context:", requestContext);
      console.debug("json:", JSON.stringify(requestContext));
      console.debug("inspect:", String(ed), String(secp));
      console.debug("keys:", Object.keys(ed), Object.keys(secp));
    } finally {
      logSpy.mockRestore();
    }

    const output = captured.join("\n");
    expect(output.length).toBeGreaterThan(0);

    // The literal secrets, in every encoding they could plausibly surface in.
    const ed25519SeedHex = "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90";
    expect(output).not.toContain(FIXED_ED25519_PKCS8_B64);
    expect(output).not.toContain(ed25519SeedHex);
    expect(output).not.toContain(FIXED_SECP256K1_HEX);
    expect(output).not.toContain(FIXED_SECP256K1_HEX.slice(2));
    // And the raw DER bytes, in case an object dump rendered them as a buffer.
    expect(output).not.toContain(Buffer.from(FIXED_ED25519_PKCS8_B64, "base64").toString("hex"));
  });
});

describe("the viem Account wrapper signs identically to the raw account (D-63 completion)", () => {
  it("signTypedData: a Safe-shaped EIP-712 payload signs byte-for-byte the same", async () => {
    const signer = EnvSecp256k1Signer.fromHex(FIXED_SECP256K1_HEX);
    const wrapped = await viemAccountFor(signer);
    const raw = privateKeyToAccount(FIXED_SECP256K1_HEX);

    // The exact shape protocol-kit signs for a Safe owner signature.
    const typedData = {
      domain: { chainId: 80002, verifyingContract: "0xFeCB8688Da42bC47AF08348E032007978C83CFb8" as const },
      types: {
        SafeTx: [
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "data", type: "bytes" },
          { name: "operation", type: "uint8" },
          { name: "safeTxGas", type: "uint256" },
          { name: "baseGas", type: "uint256" },
          { name: "gasPrice", type: "uint256" },
          { name: "gasToken", type: "address" },
          { name: "refundReceiver", type: "address" },
          { name: "nonce", type: "uint256" },
        ],
      },
      primaryType: "SafeTx" as const,
      message: {
        to: "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582" as const,
        value: 0n,
        data: "0xa9059cbb" as const,
        operation: 0,
        safeTxGas: 0n,
        baseGas: 0n,
        gasPrice: 0n,
        gasToken: "0x0000000000000000000000000000000000000000" as const,
        refundReceiver: "0x0000000000000000000000000000000000000000" as const,
        nonce: 7n,
      },
    };

    expect(await wrapped.signTypedData(typedData as never)).toBe(
      await raw.signTypedData(typedData as never),
    );
  });

  it("signMessage: identical bytes through the wrapper", async () => {
    const signer = EnvSecp256k1Signer.fromHex(FIXED_SECP256K1_HEX);
    const wrapped = await viemAccountFor(signer);
    const raw = privateKeyToAccount(FIXED_SECP256K1_HEX);
    const message = { raw: `0x${"ab".repeat(32)}` } as const;

    expect(await wrapped.signMessage({ message })).toBe(await raw.signMessage({ message }));
  });

  it("signTransaction: identical bytes through the wrapper", async () => {
    const signer = EnvSecp256k1Signer.fromHex(FIXED_SECP256K1_HEX);
    const wrapped = await viemAccountFor(signer);
    const raw = privateKeyToAccount(FIXED_SECP256K1_HEX);
    const tx = {
      to: "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582" as const,
      value: 1n,
      nonce: 3,
      gas: 21000n,
      maxFeePerGas: 30000000000n,
      maxPriorityFeePerGas: 1000000000n,
      chainId: 80002,
      type: "eip1559" as const,
    };

    expect(await wrapped.signTransaction(tx as never)).toBe(await raw.signTransaction(tx as never));
  });

  it("the wrapper exposes the same address, and no key material", async () => {
    const signer = EnvSecp256k1Signer.fromHex(FIXED_SECP256K1_HEX);
    const wrapped = await viemAccountFor(signer);
    expect(wrapped.address).toBe(privateKeyToAccount(FIXED_SECP256K1_HEX).address);
    expect(JSON.stringify(wrapped)).not.toContain(FIXED_SECP256K1_HEX.slice(2));
  });
});
