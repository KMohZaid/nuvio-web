import { Check, LogOut } from "lucide-react";
import { useState } from "react";
import type { Profile } from "../types";

function Avatar({ profile }: { profile?: Profile }) {
  return (
    <span
      className="profile-avatar"
      style={{ background: profile?.avatarColorHex || "#58616b" }}
    >
      {profile?.avatarUrl ? (
        <img src={profile.avatarUrl} alt="" />
      ) : (
        <b>{profile?.name.slice(0, 1).toUpperCase() || "N"}</b>
      )}
    </span>
  );
}

export function ProfileSwitcher({
  profiles,
  active,
  onSelect,
  onSignOut,
}: {
  profiles: Profile[];
  active: Profile | null;
  onSelect(profile: Profile): void;
  onSignOut(): void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="profile-menu-wrap">
      <button
        className="profile-trigger"
        aria-label="Profiles"
        title={active?.name || "Profiles"}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Avatar profile={active ?? undefined} />
      </button>
      {open && (
        <>
          <button
            className="profile-menu-dismiss"
            aria-label="Close profiles"
            onClick={() => setOpen(false)}
          />
          <section className="profile-popover">
            <header>
              <span className="eyebrow">WHO'S WATCHING?</span>
              <strong>{active?.name}</strong>
            </header>
            <div className="profile-icon-grid">
              {profiles.map((profile) => (
                <button
                  key={profile.profileIndex}
                  className={
                    profile.profileIndex === active?.profileIndex
                      ? "active"
                      : ""
                  }
                  onClick={() => {
                    onSelect(profile);
                    setOpen(false);
                  }}
                >
                  <Avatar profile={profile} />
                  <span>{profile.name}</span>
                  {profile.profileIndex === active?.profileIndex && (
                    <Check className="profile-selected" />
                  )}
                </button>
              ))}
            </div>
            <button className="profile-signout" onClick={onSignOut}>
              <LogOut />
              <span>Sign out</span>
            </button>
          </section>
        </>
      )}
    </div>
  );
}
