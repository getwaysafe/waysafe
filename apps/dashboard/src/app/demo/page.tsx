import { execSync } from "node:child_process";
import { DemoClient } from "./DemoClient";

function commitHash(): string {
  try {
    return execSync("git rev-parse --short HEAD", { cwd: process.cwd() }).toString().trim();
  } catch {
    return "unknown";
  }
}

export default async function DemoPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const autoplay = params.autoplay === "1";
  return <DemoClient autoplay={autoplay} commit={commitHash()} />;
}
