import "server-only";

/**
 * D-42: constants shared with `examples/demo-merchant.ts`. Not imported
 * from there directly -- that script lives outside the dashboard's own
 * source tree, and these are plain literals, so duplicating four constants
 * is simpler and safer than reaching across app boundaries for them. Keep
 * these in sync with demo-merchant.ts's own copies if either changes.
 */
export const GOODBEANS_PAY_TO = "0x600dc0ff600Dc0FF600dC0fF600dc0ff600dC0fF";
export const SHINYGADGETS_PAY_TO = "0xBAdBadbADBaDBADBadbADbaDBadBaDBADBadBAD0";
export const AMOY_USDC_ADDRESS = "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582";

export const DEMO_MERCHANT_URL = (process.env.WAYSAFE_DEMO_MERCHANT_URL ?? "http://127.0.0.1:4402").replace(/\/$/, "");
export const GOODBEANS_RESOURCE_URL = `${DEMO_MERCHANT_URL}/pay/goodbeans`;
export const SHINYGADGETS_RESOURCE_URL = `${DEMO_MERCHANT_URL}/pay/shinygadgets`;

export const WAYSAFE_API_BASE_URL = process.env.WAYSAFE_API_BASE_URL ?? "http://localhost:3001";

/**
 * The instruction the mandate scene shows and actually attempts to
 * compile. Merchant identity is deliberately absent from this sentence:
 * an on-chain `payTo` address is infrastructure, not something plain
 * English can state, so it is always attached separately (see
 * `policy.ts`'s `buildDemoPolicy`) regardless of whether compilation used
 * a live model or the offline fixture path -- this is not a fallback
 * shortcut, it is how merchant identity for this rail always works.
 */
export const DEMO_INSTRUCTION =
  "You may spend up to $20 per day. Never spend more than $10 in a single transaction. " +
  "Ask me before paying any merchant I haven't approved.";
