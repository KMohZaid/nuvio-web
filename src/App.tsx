import {
  Compass,
  Home,
  Library,
  LogOut,
  Puzzle,
  Search,
  Settings,
  UserRound,
} from "lucide-react";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
} from "react";
import { AuthScreen } from "./components/AuthScreen";
import { ContinueWatching } from "./components/ContinueWatching";
import { Details } from "./components/Details";
import { Discover } from "./components/Discover";
import { Hero, MediaRow, PosterCard } from "./components/Media";
import { Player } from "./components/Player";
import { ProfileSwitcher } from "./components/ProfileSwitcher";
import {
  blobBoolean,
  loadAddons,
  loadAvatarCatalog,
  loadLibrary,
  loadProfiles,
  loadProgress,
  loadSettingsBlob,
  loadWatchedItems,
  pushBlobBoolean,
  restoreSession,
  saveAddons,
  settingsPlatform,
  setWatched,
  signOut,
  type SettingsBlob,
} from "./lib/account";
import {
  loadHome,
  loadInstalledAddons,
  normalizeManifestUrl,
  resolveMeta,
  searchAddons,
} from "./lib/addons";
import { launchExternalPlayer } from "./lib/externalPlayer";
import {
  buildContinueWatching,
  buildWatchIndex,
  watchKey,
  type WatchIndex,
} from "./lib/progress";
import { useProgressiveList } from "./lib/useProgressiveList";
import type {
  AddonRow,
  CatalogSection,
  ExternalPlayerMode,
  InstalledAddon,
  LibraryItem,
  Meta,
  NavKey,
  Profile,
  ProgressRow,
  Session,
  Stream,
  Video,
  WatchedItem,
} from "./types";

const nav: Array<{ key: NavKey; label: string; icon: typeof Home }> = [
  { key: "home", label: "Home", icon: Home },
  { key: "discover", label: "Discover", icon: Compass },
  { key: "library", label: "Library", icon: Library },
  { key: "addons", label: "Addons", icon: Puzzle },
  { key: "settings", label: "Settings", icon: Settings },
];

const AMOLED_CACHE_KEY = "nuvio-web-amoled";

// The synced value arrives a round trip after boot. Painting the last known
// theme immediately avoids a flash of the wrong background on every launch.
document.documentElement.dataset.theme =
  localStorage.getItem(AMOLED_CACHE_KEY) === "true" ? "amoled" : "default";

export function App() {
  const [booting, setBooting] = useState(true);
  const [session, setSession] = useState<Session | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [addonRows, setAddonRows] = useState<AddonRow[]>([]);
  const [addons, setAddons] = useState<InstalledAddon[]>([]);
  const [sections, setSections] = useState<CatalogSection[]>([]);
  const [library, setLibrary] = useState<LibraryItem[]>([]);
  const [progress, setProgress] = useState<ProgressRow[]>([]);
  const [watchedItems, setWatchedItems] = useState<WatchedItem[]>([]);
  const [recentMetadata, setRecentMetadata] = useState<Meta[]>([]);
  const [settingsBlob, setSettingsBlob] = useState<SettingsBlob | null>(null);
  const [externalPlayer, setExternalPlayer] = useState<ExternalPlayerMode>(
    () =>
      (localStorage.getItem(
        "nuvio-web-external-player",
      ) as ExternalPlayerMode | null) ?? "internal",
  );
  const [active, setActive] = useState<NavKey>("home");
  // The nav highlight follows `active` immediately; the page body renders from
  // the deferred copy, so a tap paints the new tab first and the heavy list
  // render happens in a later, interruptible pass instead of blocking it.
  const deferredActive = useDeferredValue(active);
  const [selected, setSelected] = useState<Meta | null>(null);
  const [catalog, setCatalog] = useState<CatalogSection | null>(null);
  const [playback, setPlayback] = useState<{
    stream: Stream;
    meta: Meta;
    video?: Video;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Meta[]>([]);
  const [searching, setSearching] = useState(false);
  useEffect(() => {
    restoreSession()
      .then((value) => {
        setSession(value);
      })
      .finally(() => setBooting(false));
  }, []);
  const hydrate = useCallback(async () => {
    if (!session) return;
    setLoading(true);
    setMessage("");
    try {
      const [rawProfiles, avatars] = await Promise.all([
        loadProfiles(),
        loadAvatarCatalog().catch(() => []),
      ]);
      const avatarUrls = new Map(
        avatars.map((item) => [item.id, item.imageUrl]),
      );
      const nextProfiles = rawProfiles.map((item) => ({
        ...item,
        avatarUrl:
          item.avatarUrl ||
          (item.avatarId ? avatarUrls.get(item.avatarId) : undefined),
      }));
      const stored = Number(localStorage.getItem("nuvio-active-profile") ?? 1);
      const nextProfile =
        nextProfiles.find((item) => item.profileIndex === stored) ??
        nextProfiles[0];
      setProfiles(nextProfiles);
      setProfile(nextProfile ?? null);
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Account loading failed",
      );
    } finally {
      setLoading(false);
    }
  }, [session]);
  useEffect(() => {
    hydrate();
  }, [hydrate]);
  const loadProfileData = useCallback(async () => {
    if (!profile) return;
    setLoading(true);
    try {
      const [rows, nextLibrary, nextProgress, nextWatched, blob] =
        await Promise.all([
          loadAddons(profile.profileIndex),
          loadLibrary(profile.profileIndex),
          loadProgress(profile.profileIndex),
          loadWatchedItems(profile.profileIndex).catch(() => []),
          // A settings row that will not load must not block the catalogs.
          loadSettingsBlob(profile.profileIndex).catch(() => null),
        ]);
      setAddonRows(rows);
      setLibrary(nextLibrary);
      setProgress(nextProgress);
      setWatchedItems(nextWatched);
      if (blob) setSettingsBlob(blob);
      const installed = await loadInstalledAddons(rows);
      setAddons(installed);
      const home = await loadHome(installed);
      setSections(home.sections);
      const known = new Map<string, Meta>();
      for (const item of [
        ...home.sections.flatMap((section) => section.items),
        ...nextLibrary,
      ])
        known.set(item.id, item);
      const watchedTitles = new Map(
        nextWatched.map((item) => [item.contentId, item.title]),
      );
      const identities = [
        ...nextProgress.map((item) => ({
          id: item.contentId,
          type: item.contentType,
          at: item.lastWatched,
        })),
        ...nextWatched.map((item) => ({
          id: item.contentId,
          type: item.contentType,
          at: item.watchedAt,
        })),
      ]
        .filter((item) => item.id && item.type)
        .sort((a, b) => b.at - a.at);
      const unique = new Map<string, { type: string; at: number }>();
      for (const item of identities)
        if (!unique.has(item.id))
          unique.set(item.id, { type: item.type, at: item.at });
      const resolved = await Promise.all(
        [...unique].slice(0, 20).map(async ([id, identity]) => {
          const existing = known.get(id);
          if (existing?.videos.length) return existing;
          const seed: Meta = {
            id,
            type: identity.type,
            name: watchedTitles.get(id) || existing?.name || "Recently watched",
            genres: [],
            cast: [],
            director: [],
            writer: [],
            trailers: [],
            externalRatings: [],
            videos: [],
            manifestUrl: existing?.manifestUrl || "",
            addonName: existing?.addonName || "",
          };
          return resolveMeta(seed, installed).catch(() => existing ?? seed);
        }),
      );
      setRecentMetadata(resolved);
      if (home.errors.length)
        setMessage(
          `${home.errors.length} addon request${home.errors.length === 1 ? "" : "s"} could not load in this browser.`,
        );
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Profile data failed",
      );
    } finally {
      setLoading(false);
    }
  }, [profile]);
  useEffect(() => {
    loadProfileData();
  }, [loadProfileData]);
  async function runSearch() {
    if (!query.trim()) return;
    setSearching(true);
    setActive("discover");
    try {
      setResults(await searchAddons(query.trim(), addons));
    } finally {
      setSearching(false);
    }
  }
  async function updateAddons(next: AddonRow[]) {
    if (!profile) return;
    setAddonRows(next);
    await saveAddons(profile.profileIndex, next);
    await loadProfileData();
  }
  async function addAddon(url: string) {
    const normalized = normalizeManifestUrl(url);
    if (addonRows.some((item) => item.url === normalized))
      throw new Error("That addon is already installed.");
    await updateAddons([
      ...addonRows,
      { url: normalized, enabled: true, sortOrder: addonRows.length },
    ]);
  }
  const amoled = blobBoolean(settingsBlob, "theme_settings", "amoled_enabled", false);
  useEffect(() => {
    document.documentElement.dataset.theme = amoled ? "amoled" : "default";
    localStorage.setItem(AMOLED_CACHE_KEY, String(amoled));
  }, [amoled]);

  /** Applies the theme immediately and rolls back if the push is rejected. */
  async function updateAmoled(next: boolean) {
    if (!profile || !settingsBlob) return;
    const previous = settingsBlob;
    setSettingsBlob({
      ...settingsBlob,
      features: {
        ...settingsBlob.features,
        theme_settings: {
          ...(settingsBlob.features?.theme_settings ?? {}),
          amoled_enabled: { type: "boolean", value: next },
        },
      },
    });
    try {
      setSettingsBlob(
        await pushBlobBoolean(
          profile.profileIndex,
          previous,
          "theme_settings",
          "amoled_enabled",
          next,
        ),
      );
    } catch (error) {
      setSettingsBlob(previous);
      setMessage(
        error instanceof Error ? error.message : "Could not save the theme",
      );
    }
  }

  const hero = sections[0]?.items[0];
  const watchIndex = useMemo(
    () => buildWatchIndex(progress, watchedItems),
    [progress, watchedItems],
  );
  /**
   * Flips the badge before the server answers and rolls back if the push
   * fails, so a hold-to-mark feels immediate on a phone.
   */
  async function toggleWatched(meta: Meta, video: Video | undefined, next: boolean) {
    if (!profile) return;
    const identity = {
      contentId: meta.id,
      contentType: meta.type,
      season: video?.season,
      episode: video?.episode,
    };
    const key = watchKey(meta.id, video?.season, video?.episode);
    const previousWatched = watchedItems;
    const previousProgress = progress;
    setWatchedItems((current) =>
      next
        ? [
            ...current,
            {
              contentId: meta.id,
              contentType: meta.type,
              title: video?.title || meta.name,
              season: video?.season,
              episode: video?.episode,
              watchedAt: Date.now(),
            },
          ]
        : current.filter(
            (item) =>
              watchKey(item.contentId, item.season, item.episode) !== key,
          ),
    );
    // Marking either way clears the resume point server-side, so drop it here
    // too or the bar would linger under a row that was just toggled.
    setProgress((current) =>
      current.filter(
        (row) => watchKey(row.contentId, row.season, row.episode) !== key,
      ),
    );
    try {
      await setWatched(
        profile.profileIndex,
        identity,
        video?.title || meta.name,
        next,
        previousProgress,
      );
    } catch (error) {
      setWatchedItems(previousWatched);
      setProgress(previousProgress);
      setMessage(
        error instanceof Error ? error.message : "Could not save watched state",
      );
    }
  }

  const continueItems = useMemo(
    () =>
      buildContinueWatching(progress, watchedItems, [
        ...sections.flatMap((section) => section.items),
        ...library,
        ...recentMetadata,
      ]),
    [library, progress, recentMetadata, sections, watchedItems],
  );
  if (booting)
    return (
      <div className="splash">
        <img src="/Nuvio-icon.png" alt="" />
        <span>Restoring Nuvio…</span>
      </div>
    );
  if (!session) return <AuthScreen onSession={setSession} />;
  if (playback)
    return <Player {...playback} onClose={() => setPlayback(null)} />;
  return (
    <div className="app-shell">
      <aside className="rail">
        <img src="/Nuvio-icon.png" alt="Nuvio" />
        {nav.map((item) => (
          <button
            key={item.key}
            className={active === item.key ? "active" : ""}
            title={item.label}
            onClick={() => {
              setActive(item.key);
              setCatalog(null);
            }}
          >
            <item.icon />
          </button>
        ))}
      </aside>
      <header className="topbar">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            runSearch();
          }}
        >
          <Search />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search movies and series…"
          />
          <button>{searching ? "…" : "Search"}</button>
        </form>
        <ProfileSwitcher
          profiles={profiles}
          active={profile}
          onSelect={(next) => {
            localStorage.setItem(
              "nuvio-active-profile",
              String(next.profileIndex),
            );
            setProfile(next);
          }}
          onSignOut={async () => {
            await signOut();
            setSession(null);
          }}
        />
      </header>
      <main className="content">
        {message && (
          <div className="notice">
            <span>{message}</span>
            <button onClick={() => setMessage("")}>×</button>
          </div>
        )}
        {(loading || deferredActive !== active) && (
          <>
            {/* Veil and spinner are siblings, never nested: iOS rasterises a
                backdrop-filter element's own children through the same filter,
                which would blur the spinner along with the page. */}
            <div className="page-veil" aria-hidden="true" />
            <div className="page-spinner" role="status" aria-label="Loading">
              <i />
            </div>
          </>
        )}
        {catalog ? (
          <CatalogView
            section={catalog}
            index={watchIndex}
            onBack={() => setCatalog(null)}
            onOpen={setSelected}
          />
        ) : deferredActive === "home" ? (
          <HomeView
            hero={hero}
            sections={sections}
            continueItems={continueItems}
            index={watchIndex}
            onOpen={setSelected}
            onSeeAll={setCatalog}
          />
        ) : deferredActive === "discover" ? (
          <Discover
            addons={addons}
            index={watchIndex}
            query={query}
            results={results}
            onOpen={setSelected}
          />
        ) : deferredActive === "library" ? (
          <LibraryView
            items={library}
            index={watchIndex}
            onOpen={setSelected}
          />
        ) : deferredActive === "addons" ? (
          <AddonsPage
            addons={addons}
            rows={addonRows}
            onToggle={(index) =>
              updateAddons(
                addonRows.map((row, rowIndex) =>
                  rowIndex === index ? { ...row, enabled: !row.enabled } : row,
                ),
              )
            }
            onAdd={addAddon}
            onRefresh={loadProfileData}
          />
        ) : (
          <SettingsPage
            session={session}
            profile={profile}
            amoled={amoled}
            amoledReady={settingsBlob != null}
            onAmoled={updateAmoled}
            externalPlayer={externalPlayer}
            onExternalPlayer={(mode) => {
              setExternalPlayer(mode);
              localStorage.setItem("nuvio-web-external-player", mode);
            }}
            onSignOut={async () => {
              await signOut();
              setSession(null);
            }}
          />
        )}
      </main>
      <nav className="bottom-nav">
        {nav.map((item) => (
          <button
            key={item.key}
            className={active === item.key ? "active" : ""}
            onClick={() => {
              setActive(item.key);
              setCatalog(null);
            }}
          >
            <item.icon />
            <span>{item.label}</span>
          </button>
        ))}
      </nav>
      {selected && (
        <Details
          seed={selected}
          addons={addons}
          watchIndex={watchIndex}
          onSetWatched={toggleWatched}
          inLibrary={library.some(
            (item) => item.id === selected.id && item.type === selected.type,
          )}
          onClose={() => setSelected(null)}
          onLibrary={() =>
            setMessage(
              "Library writes are disabled in this safety-first preview.",
            )
          }
          onPlay={(stream, meta, video) => {
            const url = stream.url || stream.externalUrl;
            if (externalPlayer !== "internal" && url) {
              launchExternalPlayer(
                externalPlayer,
                url,
                video?.title || meta.name,
              );
              setMessage(
                externalPlayer === "m3u"
                  ? "Playlist downloaded. Open it with your preferred player."
                  : `Opening ${externalPlayer === "vlc" ? "VLC" : "Outplayer"}…`,
              );
              setSelected(null);
              return;
            }
            setPlayback({ stream, meta, video });
          }}
        />
      )}
    </div>
  );
}

/**
 * Home renders its rows progressively for the same reason the grids do: a
 * dozen catalog rows of twenty posters each is several hundred cards, and
 * committing them all at once is what delayed the tab switch.
 */
function HomeView({
  hero,
  sections,
  continueItems,
  index,
  onOpen,
  onSeeAll,
}: {
  hero?: Meta;
  sections: CatalogSection[];
  continueItems: ReturnType<typeof buildContinueWatching>;
  index: WatchIndex;
  onOpen(item: Meta): void;
  onSeeAll(section: CatalogSection): void;
}) {
  const { visible } = useProgressiveList(sections);
  return (
    <>
      {hero && <Hero item={hero} onOpen={() => onOpen(hero)} />}
      {continueItems.length > 0 && (
        <ContinueWatching cards={continueItems} onOpen={onOpen} />
      )}
      {visible.map((section) => (
        <MediaRow
          key={section.key}
          section={section}
          index={index}
          onOpen={onOpen}
          onSeeAll={() => onSeeAll(section)}
        />
      ))}
    </>
  );
}

/**
 * The synced library split by kind. Counts come from the whole set rather
 * than the filtered view so an empty tab still says so plainly.
 */
function LibraryView({
  items,
  index,
  onOpen,
}: {
  items: LibraryItem[];
  index: WatchIndex;
  onOpen(item: Meta): void;
}) {
  const [tab, setTab] = useState<"all" | "movie" | "series">("all");
  const counts = useMemo(() => {
    let movie = 0;
    let series = 0;
    for (const item of items) {
      if (item.type === "series") series += 1;
      else if (item.type === "movie") movie += 1;
    }
    return { all: items.length, movie, series };
  }, [items]);
  const filtered = useMemo(
    () => (tab === "all" ? items : items.filter((item) => item.type === tab)),
    [items, tab],
  );
  const { visible } = useProgressiveList(filtered);
  const tabs = [
    { key: "all", label: "All", count: counts.all },
    { key: "movie", label: "Movies", count: counts.movie },
    { key: "series", label: "Series", count: counts.series },
  ] as const;

  return (
    <section className="grid-page">
      <span className="eyebrow">NUVIO WEB</span>
      <h1>Your library</h1>
      <p>{counts.all} synced titles</p>
      <div className="segmented">
        {tabs.map((item) => (
          <button
            key={item.key}
            className={tab === item.key ? "active" : undefined}
            aria-pressed={tab === item.key}
            onClick={() => setTab(item.key)}
          >
            {item.label}
            <i>{item.count}</i>
          </button>
        ))}
      </div>
      {filtered.length === 0 ? (
        <div className="empty-state">
          <strong>Nothing here yet</strong>
          <span>
            {tab === "all"
              ? "Titles you add to your Nuvio library will appear here."
              : `No ${tab === "movie" ? "movies" : "series"} in your library.`}
          </span>
        </div>
      ) : (
        <div className="poster-grid">
          {visible.map((item) => (
            <PosterCard
              key={`${item.type}:${item.id}`}
              item={item}
              index={index}
              onOpen={onOpen}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function CatalogView({
  section,
  index,
  onBack,
  onOpen,
}: {
  section: CatalogSection;
  index: WatchIndex;
  onBack(): void;
  onOpen(item: Meta): void;
}) {
  const { visible, complete } = useProgressiveList(section.items);
  return (
    <section className="grid-page">
      <button className="back-inline" onClick={onBack}>
        ← Back
      </button>
      <span className="eyebrow">{section.addonName}</span>
      <h1>{section.name}</h1>
      <p>{section.type === "series" ? "Series" : "Movies"}</p>
      <div className="poster-grid">
        {visible.map((item) => (
          <PosterCard
            key={item.id}
            item={item}
            index={index}
            onOpen={onOpen}
          />
        ))}
      </div>
      {!complete && <div className="grid-filling" aria-hidden="true" />}
    </section>
  );
}
function AddonsPage({
  addons,
  rows,
  onToggle,
  onAdd,
  onRefresh,
}: {
  addons: InstalledAddon[];
  rows: AddonRow[];
  onToggle(index: number): void;
  onAdd(url: string): Promise<void>;
  onRefresh(): void;
}) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  return (
    <section className="settings-page">
      <span className="eyebrow">CONTENT</span>
      <h1>Addons</h1>
      <p>
        These are synced with the selected Nuvio profile. Catalog requests go
        straight from this device to each addon.
      </p>
      <form
        className="addon-install"
        onSubmit={async (event) => {
          event.preventDefault();
          setError("");
          try {
            await onAdd(url);
            setUrl("");
          } catch (reason) {
            setError(
              reason instanceof Error
                ? reason.message
                : "Could not install addon",
            );
          }
        }}
      >
        <input
          type="url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://addon.example/manifest.json"
        />
        <button className="primary">Install</button>
      </form>
      {error && <div className="notice error">{error}</div>}
      <div className="setting-card">
        <header>
          <h2>Installed addons</h2>
          <button className="secondary" onClick={onRefresh}>
            Refresh
          </button>
        </header>
        {addons.map((addon, index) => (
          <article className="addon-row" key={`${addon.url}:${index}`}>
            {addon.manifest?.logo ? (
              <img src={addon.manifest.logo} alt="" />
            ) : (
              <span>
                <Puzzle />
              </span>
            )}
            <div>
              <strong>
                {addon.manifest?.name || addon.name || "Unavailable addon"}
              </strong>
              <small>
                {addon.error ||
                  `${addon.manifest?.catalogs?.length ?? 0} catalogs · ${addon.manifest?.version ?? "Unknown version"}`}
              </small>
              <code>{addon.url}</code>
            </div>
            <label className="switch">
              <input
                type="checkbox"
                checked={rows[index]?.enabled ?? false}
                onChange={() => onToggle(index)}
              />
              <i />
            </label>
          </article>
        ))}
      </div>
    </section>
  );
}
function SettingsPage({
  session,
  profile,
  amoled,
  amoledReady,
  onAmoled,
  externalPlayer,
  onExternalPlayer,
  onSignOut,
}: {
  session: Session;
  profile: Profile | null;
  amoled: boolean;
  amoledReady: boolean;
  onAmoled(next: boolean): void;
  externalPlayer: ExternalPlayerMode;
  onExternalPlayer(mode: ExternalPlayerMode): void;
  onSignOut(): void;
}) {
  return (
    <section className="settings-page">
      <span className="eyebrow">WEB CLIENT</span>
      <h1>Settings</h1>
      <p>
        This preview keeps media traffic off the Nuvio host and uses the browser
        whenever possible.
      </p>
      <div className="setting-card">
        <header>
          <h2>Appearance</h2>
        </header>
        <div className="theme-row">
          <span>
            <strong>AMOLED black</strong>
            <small>
              Synced with your Nuvio {settingsPlatform()} settings, so it
              follows this profile across devices.
            </small>
          </span>
          <label className="switch">
            <input
              type="checkbox"
              checked={amoled}
              disabled={!amoledReady}
              onChange={(event) => onAmoled(event.target.checked)}
            />
            <i />
          </label>
        </div>
      </div>
      <div className="setting-card">
        <header>
          <h2>Account</h2>
        </header>
        <div className="info-row">
          <UserRound />
          <span>
            <strong>{profile?.name}</strong>
            <small>{session.user.email}</small>
          </span>
        </div>
        <div className="info-row">
          <Settings />
          <span>
            <strong>
              {session.backend.selfHosted
                ? "Self-hosted backend"
                : "Official backend"}
            </strong>
            <small>{session.backend.url}</small>
          </span>
        </div>
        <button className="danger" onClick={onSignOut}>
          <LogOut /> Sign out on this device
        </button>
      </div>
      <div className="setting-card">
        <header>
          <h2>Playback compatibility</h2>
        </header>
        <label className="setting-select-row">
          <span>
            <strong>Default player</strong>
            <small>
              VLC and Outplayer use their iOS/iPadOS URL schemes. M3U works on
              desktop too.
            </small>
          </span>
          <select
            value={externalPlayer}
            onChange={(event) =>
              onExternalPlayer(event.target.value as ExternalPlayerMode)
            }
          >
            <option value="internal">Nuvio web player</option>
            <option value="vlc">VLC (iOS/iPadOS)</option>
            <option value="outplayer">Outplayer (iOS/iPadOS)</option>
            <option value="m3u">Download M3U playlist</option>
          </select>
        </label>
        <p>
          The custom player handles browser-ready MP4/WebM and HLS, including
          HLS audio-track selection. MKV, torrents, custom-header streams, and
          unsupported HEVC, TrueHD, EAC3, or DTS audio still need an external
          player or a future local companion service.
        </p>
      </div>
      <div className="setting-card">
        <header>
          <h2>Install as an app</h2>
        </header>
        <p>
          On iPhone or iPad, open Safari’s Share menu and choose{" "}
          <b>Add to Home Screen</b>. On desktop Chrome or Edge, use the install
          icon in the address bar.
        </p>
      </div>
    </section>
  );
}
