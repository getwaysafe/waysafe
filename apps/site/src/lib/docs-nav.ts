/** The public repo, on main. Every source link on the docs site points here. */
export const REPO = "https://github.com/getwaysafe/waysafe";
export const REPO_TREE = `${REPO}/blob/main`;

export const DOCS_NAV: { href: string; label: string; blurb: string }[] = [
  { href: "/docs", label: "Overview", blurb: "What this is, and what you can build." },
  { href: "/docs/quickstart", label: "Quickstart", blurb: "Five commands to a real decision, locally." },
  { href: "/docs/enforcement", label: "Enforcement", blurb: "The two endpoints a rail calls before money moves." },
  { href: "/docs/concepts", label: "Concepts", blurb: "Mandate, version, authorization, evidence." },
  { href: "/docs/reference", label: "Reference", blurb: "SDK methods, raw REST, and every reason code." },
  { href: "/docs/policy", label: "Policy schema", blurb: "Every field, and whether the engine enforces it today." },
];
