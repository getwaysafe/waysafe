"use client";

import { useActionState } from "react";
import { login, type LoginState } from "./actions";

const initialState: LoginState = { error: null };

export default function LoginForm() {
  const [state, formAction, pending] = useActionState(login, initialState);

  return (
    <form className="login" action={formAction}>
      <h1>Waysafe</h1>
      <p className="subtitle">Sign in with an org credential to view your dashboard.</p>
      {state.error && <p className="error">{state.error}</p>}
      <label htmlFor="apiKey" style={{ fontSize: 12, color: "var(--muted)" }}>
        API key
      </label>
      <input id="apiKey" name="apiKey" type="password" placeholder="wsf_live_..." autoComplete="off" required />
      <button type="submit" disabled={pending}>
        {pending ? "Checking…" : "Sign in"}
      </button>
    </form>
  );
}
