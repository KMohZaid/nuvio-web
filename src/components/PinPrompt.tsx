import { useEffect, useRef, useState } from "react";
import { verifyProfilePin } from "../lib/account";
import type { Profile } from "../types";

/** Nuvio's PINs are four digits and submit on the fourth. */
const PIN_LENGTH = 4;

/**
 * Asks for a profile's PIN.
 *
 * Verification happens on the backend through the same RPC the official
 * clients use, so a PIN set on one device works here and the lockout after
 * repeated failures is enforced in one place rather than per client. The PIN
 * itself is never stored.
 */
export function PinPrompt({
  profile,
  cancelLabel = "Cancel",
  onUnlocked,
  onCancel,
}: {
  profile: Profile;
  cancelLabel?: string;
  onUnlocked(): void;
  onCancel(): void;
}) {
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [lockedFor, setLockedFor] = useState(0);
  const input = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);

  /**
   * Keeps the dialog inside the part of the screen the keyboard is not
   * covering.
   *
   * An on-screen keyboard shrinks the visual viewport but leaves `dvh` and the
   * layout viewport alone, so a dialog centred in the page sits behind it. The
   * visual viewport reports what is actually visible, and the scrim is sized
   * and offset to match.
   */
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const root = document.documentElement;
    const apply = () => {
      root.style.setProperty("--pin-visible-height", `${viewport.height}px`);
      root.style.setProperty("--pin-visible-top", `${viewport.offsetTop}px`);
    };
    apply();
    viewport.addEventListener("resize", apply);
    viewport.addEventListener("scroll", apply);
    return () => {
      viewport.removeEventListener("resize", apply);
      viewport.removeEventListener("scroll", apply);
      root.style.removeProperty("--pin-visible-height");
      root.style.removeProperty("--pin-visible-top");
    };
  }, []);

  // Counts the lockout down rather than leaving a stale "try again in 30s".
  useEffect(() => {
    if (lockedFor <= 0) return;
    const timer = window.setInterval(
      () => setLockedFor((current) => Math.max(0, current - 1)),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [lockedFor]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  async function submit(value: string) {
    setBusy(true);
    setError("");
    try {
      const result = await verifyProfilePin(profile.profileIndex, value);
      if (result.unlocked) {
        onUnlocked();
        return;
      }
      setPin("");
      setLockedFor(result.retryAfterSeconds);
      setError(
        result.message ||
          (result.retryAfterSeconds > 0
            ? "Too many attempts."
            : "That PIN is not right."),
      );
      input.current?.focus();
    } catch (reason) {
      setPin("");
      setError(
        reason instanceof Error ? reason.message : "Could not check that PIN.",
      );
    } finally {
      setBusy(false);
    }
  }

  const locked = lockedFor > 0;

  return (
    <div className="pin-scrim" role="presentation">
      <section
        className="pin-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="pin-title"
      >
        <span
          className="pin-avatar"
          style={{ background: profile.avatarColorHex }}
          aria-hidden="true"
        >
          {profile.avatarUrl ? (
            <img src={profile.avatarUrl} alt="" />
          ) : (
            profile.name.slice(0, 1).toUpperCase()
          )}
        </span>
        <h2 id="pin-title">{profile.name}</h2>
        <p>Enter this profile's PIN</p>

        <div className="pin-dots" aria-hidden="true">
          {Array.from({ length: PIN_LENGTH }, (_, index) => (
            <i key={index} className={index < pin.length ? "is-filled" : ""} />
          ))}
        </div>

        {/*
          A real input rather than a custom keypad: it brings up the digits-only
          keyboard on iOS, and works with a hardware keyboard and a password
          manager. It is visually hidden behind the dots above.
        */}
        <input
          ref={input}
          className="pin-input"
          value={pin}
          type="password"
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]*"
          maxLength={PIN_LENGTH}
          disabled={busy || locked}
          aria-label={`PIN for ${profile.name}`}
          onChange={(event) => {
            const digits = event.target.value.replace(/\D/g, "").slice(0, PIN_LENGTH);
            setPin(digits);
            setError("");
            // Submits itself on the fourth digit, as the other clients do.
            if (digits.length === PIN_LENGTH) void submit(digits);
          }}
        />

        {error && (
          <p className="pin-error" role="alert">
            {error}
            {locked ? ` Try again in ${lockedFor}s.` : ""}
          </p>
        )}

        <button type="button" className="secondary" onClick={onCancel}>
          {cancelLabel}
        </button>
      </section>
    </div>
  );
}
