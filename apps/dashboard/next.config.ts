import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Don't autogenerate AGENTS.md/CLAUDE.md -- this repo's own conventions
  // (CLAUDE.md at the root, DECISIONS.md) are the source of truth.
  agentRules: false,
};

export default nextConfig;
