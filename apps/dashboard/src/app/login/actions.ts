"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AgentPay, UnauthorizedError } from "@agentpay/sdk";
import { AGENTPAY_API_BASE_URL } from "../../lib/agentpay";
import { encryptSession, SESSION_COOKIE_NAME } from "../../lib/session";

export interface LoginState {
  error: string | null;
}

/**
 * The only "auth" check the dashboard does: the submitted key must
 * authenticate a real, unrevoked credential against the AgentPay API
 * itself (D-18 already enforces everything about who it belongs to and
 * what it can do -- the dashboard doesn't re-implement that). `listAgents`
 * is a lightweight, harmless org-scoped read used purely to confirm the
 * key works before it's trusted into a session cookie.
 */
export async function login(_prevState: LoginState, formData: FormData): Promise<LoginState> {
  const apiKey = String(formData.get("apiKey") ?? "").trim();
  if (!apiKey) {
    return { error: "Enter an API key." };
  }

  const client = new AgentPay({ baseUrl: AGENTPAY_API_BASE_URL, apiKey });
  try {
    await client.listAgents();
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return { error: "That key was rejected -- it may be revoked or mistyped." };
    }
    return {
      error: `Could not reach the AgentPay API at ${AGENTPAY_API_BASE_URL}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  const store = await cookies();
  store.set(SESSION_COOKIE_NAME, encryptSession(apiKey), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7, // 7 days
  });

  redirect("/mandates");
}
