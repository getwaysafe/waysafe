/**
 * D-43: flavor data for the `/story` simulation -- fabricated attacker
 * targets, and the one piece of *non*-simulated content on the page (the
 * incident figures). See CLAUDE.md's HONESTY requirement: everything else
 * in this directory is a labeled simulation; these two numbers are not, and
 * are kept in one place so the page can cite them precisely once.
 */

/** Rails the story draws as lanes. `evaluate()` doesn't take a rail -- D-32's
 * whole point is that the same decision applies no matter which one asks --
 * so this is a display label only. */
export const RAILS = ["card", "x402", "wallet", "bank"] as const;
export type Rail = (typeof RAILS)[number];

/**
 * Reported figures for a real 2026 agentic-infrastructure compromise, used
 * verbatim rather than invented. Not independently re-verified in this
 * session against a specific named publication -- cited here only as
 * "reported figures," alongside this repo's own incident summary in
 * DECISIONS.md D-32, rather than attributed to a specific outlet we cannot
 * confirm. Never used as a source for the simulation's own dollar counters,
 * which are synthetic and labeled as such (see StoryClient.tsx).
 */
export const INCIDENT_ACTIONS = 17_600;
export const INCIDENT_HOURS_TO_CLUSTER_ADMIN = 13;
export const INCIDENT_FOOTNOTE =
  `Reported figures for a 2026 agentic-infrastructure compromise: ` +
  `${INCIDENT_ACTIONS.toLocaleString("en-US")} agent actions, ` +
  `${INCIDENT_HOURS_TO_CLUSTER_ADMIN}h to cluster-admin. Context: DECISIONS.md D-32.`;

/** Domains a compromised agent tries -- never the mandate's named vendor.
 * Mostly lookalikes/burner-shaped, never in the story's directory, so they
 * resolve ASSERTED/UNKNOWN and D-3's rule ("unverified can never produce
 * ALLOW") does the real work of denying them. */
export const ATTACKER_DOMAINS = [
  "acmecloud-billing.co",
  "acme-cloud-billing.io",
  "swiftpayout-x.net",
  "quiet-settlement.cc",
  "driftwallet-relay.io",
  "fastcashout247.biz",
  "darkpool-otc.exchange",
  "shadowledger-pay.com",
  "invoice-refresh.top",
  "billing-verify-now.click",
] as const;

/** Occasionally an attempt skips a domain entirely and asserts a bare
 * name, a raw psp_account, or a raw network_mid -- every one of those is
 * exactly as untrustworthy as a name claim when the agent is the one
 * asserting it (D-34), and the story's mix of reason codes should show
 * that, not just the domain path. */
export const ATTACKER_NAMES = [
  "QuickPayout LLC",
  "Global Settlement Partners",
  "Rapid OTC Desk",
  "Anon Remit Co",
] as const;

export const ATTACKER_PSP_ACCOUNTS = ["acct_9xrelay1", "acct_zzq_drop", "acct_ghostpay77"] as const;
export const ATTACKER_NETWORK_MIDS = ["4441 9902 771", "5510 0027 349", "6011 8842 205"] as const;
export const ATTACKER_ONCHAIN_ADDRESSES = [
  "0xDEADbeefCAFEbabe0000000000000000BAD0001",
  "0xDEADbeefCAFEbabe0000000000000000BAD0002",
  "0xDEADbeefCAFEbabe0000000000000000BAD0003",
] as const;

/** Categories a draining agent plausibly tries. High-risk ones are denied by
 * the policy outright (D-10); the rest are unremarkable but still fail on
 * merchant identity. */
export const ATTACK_CATEGORIES = [
  "crypto",
  "cash_advance",
  "gambling",
  "general_merchandise",
  "software",
  "electronics",
] as const;

export const COMPROMISE_CAPTION = "/proc/self/environ dumped";
