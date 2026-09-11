#!/usr/bin/env -S npx tsx
/**
 * D-42: a tiny, real x402 merchant for the /demo page.
 *
 *   npx tsx examples/demo-merchant.ts
 *
 * Two resources, each a real HTTP 402 -- Waysafe's own adapter
 * (`apps/api/src/enforcement/x402.ts`) fetches these itself, per D-40; this
 * script never talks to Waysafe or the dashboard directly, exactly as a
 * real x402 resource server wouldn't. `/pay/goodbeans` is the merchant the
 * demo mandate allowlists (`onchain_address` = GOODBEANS_PAY_TO);
 * `/pay/shinygadgets` is a second, real, working 402 endpoint that simply
 * isn't on the allowlist -- the DENY scene.
 *
 * Both quote real Amoy test USDC (`AMOY_USDC_ADDRESS`, 6 decimals) so the
 * amounts this server states are exactly what actually moves on-chain when
 * an ALLOW is settled -- nothing here is illustrative or rounded for
 * presentation.
 *
 * The `payTo` addresses below are not wallets anyone holds a key for --
 * stable, fixed demo constants, checksummed-looking but synthetic. A
 * settled ALLOW genuinely sends test USDC to one of them; that's harmless
 * on a testnet and lets `X402_SAFE_SETTLEMENT_MODE`'s plain `transfer` be
 * proven for real without needing a merchant wallet Waysafe doesn't
 * control.
 */

import { createServer } from "node:http";

const PORT = Number(process.env.DEMO_MERCHANT_PORT ?? 4402);
const HOST = process.env.DEMO_MERCHANT_HOST ?? "127.0.0.1";
const BASE_URL = `http://${HOST}:${PORT}`;

const AMOY_USDC_ADDRESS = "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582";

export const GOODBEANS_PAY_TO = "0x600dc0ff600Dc0FF600dC0fF600dc0ff600dC0fF";
export const SHINYGADGETS_PAY_TO = "0xBAdBadbADBaDBADBadbADbaDBadBaDBADBadBAD0";

interface Merchant {
  path: string;
  description: string;
  payTo: string;
  amountAtomicUsdc: string; // 6-decimal atomic units
}

const MERCHANTS: Merchant[] = [
  {
    path: "/pay/goodbeans",
    description: "GoodBeans API -- 1 inference credit",
    payTo: GOODBEANS_PAY_TO,
    amountAtomicUsdc: "500000", // $0.50
  },
  {
    path: "/pay/shinygadgets",
    description: "ShinyGadgets API -- 1 SKU lookup",
    payTo: SHINYGADGETS_PAY_TO,
    amountAtomicUsdc: "2500000", // $2.50
  },
];

function paymentRequiredBody(merchant: Merchant) {
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: "exact",
        network: "polygon-amoy",
        maxAmountRequired: merchant.amountAtomicUsdc,
        resource: `${BASE_URL}${merchant.path}`,
        description: merchant.description,
        payTo: merchant.payTo,
        maxTimeoutSeconds: 300,
        asset: AMOY_USDC_ADDRESS,
        extra: { decimals: 6 },
      },
    ],
  };
}

const server = createServer((req, res) => {
  const path = (req.url ?? "/").split("?")[0];

  if (path === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", merchants: MERCHANTS.map((m) => m.path) }));
    return;
  }

  const merchant = MERCHANTS.find((m) => m.path === path);
  if (!merchant) {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "no such resource", known: MERCHANTS.map((m) => m.path) }));
    return;
  }

  res.writeHead(402, { "content-type": "application/json" });
  res.end(JSON.stringify(paymentRequiredBody(merchant)));
});

server.listen(PORT, HOST, () => {
  console.log(`demo merchant listening on ${BASE_URL}`);
  for (const m of MERCHANTS) {
    console.log(`  ${BASE_URL}${m.path}  (${m.description}, payTo ${m.payTo})`);
  }
});
