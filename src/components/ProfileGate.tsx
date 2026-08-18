import { Lock } from "lucide-react";
import type { Profile } from "../types";

/**
 * Who is watching, asked before anything loads.
 *
 * Nothing is fetched until a profile is chosen: addons, library and watch
 * history all belong to a profile, and loading one profile's data only to
 * replace it a moment later is both slower and wrong for a locked profile.
 */
export function ProfileGate({
  profiles,
  remember,
  onRememberChange,
  onSelect,
  onSignOut,
}: {
  profiles: Profile[];
  remember: boolean;
  onRememberChange(value: boolean): void;
  onSelect(profile: Profile): void;
  onSignOut(): void;
}) {
  return (
    <div className="profile-gate">
      <div className="profile-gate-inner">
        <h1>Who's watching?</h1>
        <div className="profile-gate-grid">
          {profiles.map((profile) => (
            <button
              type="button"
              className="profile-gate-card"
              key={profile.profileIndex}
              onClick={() => onSelect(profile)}
            >
              <span
                className="profile-gate-avatar"
                style={{ background: profile.avatarColorHex }}
              >
                {profile.avatarUrl ? (
                  <img src={profile.avatarUrl} alt="" />
                ) : (
                  profile.name.slice(0, 1).toUpperCase()
                )}
                {/* A lock here saves a tap discovering the profile is locked. */}
                {profile.pinEnabled && (
                  <i className="profile-gate-lock" aria-hidden="true">
                    <Lock />
                  </i>
                )}
              </span>
              <strong>{profile.name}</strong>
              {profile.pinEnabled && <small>Locked</small>}
            </button>
          ))}
        </div>

        {/* The app's switch, not a checkbox: a 40px target beats a 13px one
            on a phone, and it matches every other toggle in Settings. */}
        <label className="profile-gate-remember">
          <span>Use this profile next time</span>
          <span className="switch">
            <input
              type="checkbox"
              checked={remember}
              onChange={(event) => onRememberChange(event.target.checked)}
            />
            <i />
          </span>
        </label>

        <button type="button" className="secondary" onClick={onSignOut}>
          Sign out
        </button>
      </div>
    </div>
  );
}
