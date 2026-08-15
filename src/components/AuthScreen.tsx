import { Eye, EyeOff } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { officialBackend, normalizeBackend, signIn, signUp } from "../lib/account";
import type { Session } from "../types";

export function AuthScreen({ onSession }: { onSession(session: Session): void }) {
  const official = useMemo(officialBackend, []);
  const [selfHosted, setSelfHosted] = useState(!official);
  const [backendUrl, setBackendUrl] = useState("");
  const [key, setKey] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [create, setCreate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setMessage("");
    try {
      const backend = selfHosted ? normalizeBackend(backendUrl, key) : official;
      if (!backend) throw new Error("This build has no official backend. Use a self-hosted backend.");
      const session = create ? await signUp(backend, email, password) : await signIn(backend, email, password);
      if (!session) setMessage("Check your email to confirm the account, then sign in."); else onSession(session);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Sign in failed"); }
    finally { setBusy(false); }
  }

  return <main className="auth-screen">
    <div className="auth-glow" />
    <section className="auth-card">
      <img className="auth-logo" src="/nuvio-wordmark.png" alt="Nuvio" />
      <span className="eyebrow">WEB PREVIEW</span>
      <h1>{create ? "Create your account" : "Your Nuvio, anywhere."}</h1>
      <p>Install it from Safari or Chrome and keep your profiles, addons, and library in sync.</p>
      <form onSubmit={submit}>
        <label className="check-row"><input type="checkbox" checked={selfHosted} onChange={(event) => setSelfHosted(event.target.checked)} /><span><strong>Self-hosted backend</strong><small>Use your own Nuvio server and publishable key.</small></span></label>
        {selfHosted && <div className="host-fields"><label>Backend URL<input type="url" value={backendUrl} onChange={(event) => setBackendUrl(event.target.value)} placeholder="https://nuvio.example.com" required /></label><label>Publishable key<input type="password" value={key} onChange={(event) => setKey(event.target.value)} required /></label></div>}
        <label>Email<input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label>
        <label>Password<div className="password-field"><input type={showPassword ? "text" : "password"} autoComplete={create ? "new-password" : "current-password"} minLength={6} value={password} onChange={(event) => setPassword(event.target.value)} required /><button type="button" aria-label={showPassword ? "Hide password" : "Show password"} title={showPassword ? "Hide password" : "Show password"} aria-pressed={showPassword} onClick={() => setShowPassword((value) => !value)}>{showPassword ? <EyeOff /> : <Eye />}</button></div></label>
        <button className="primary wide" disabled={busy}>{busy ? "Connecting…" : create ? "Create account" : "Sign in"}</button>
      </form>
      {message && <div className="notice error">{message}</div>}
      <button className="text-button" onClick={() => { setCreate(!create); setMessage(""); }}>{create ? "Already have an account? Sign in" : "New to Nuvio? Create an account"}</button>
      <small className="security-note">Your session stays on this device. No media passes through the Nuvio web host.</small>
    </section>
  </main>;
}
