import {
  ArrowLeft,
  ChevronRight,
  RefreshCw,
  X,
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
  useRef,
  useState,
} from "react";
import { AuthScreen } from "./components/AuthScreen";
import { ContinueWatching } from "./components/ContinueWatching";
import { Details } from "./components/Details";
import { Discover } from "./components/Discover";
import {
  CollectionFolderView,
  CollectionRow,
} from "./components/Collections";
import { Hero, MediaRow, PosterCard } from "./components/Media";
import { Player } from "./components/Player";
import { ProfileSwitcher } from "./components/ProfileSwitcher";
import {
  blobBoolean,
  loadAddons,
  loadAvatarCatalog,
  loadLibrary,
  loadProfiles,
  addToLibrary,
  loadCollections,
  loadHomeLayout,
  loadProgress,
  COLLECTION_KEY_PREFIX,
  type HomeLayout,
  loadSettingsBlob,
  loadWatchedItems,
  pushBlobBoolean,
  pushProgress,
  isComplete,
  restoreSession,
  removeFromLibrary,
  saveAddons,
  settingsPlatform,
  setWatched,
  signOut,
  type SettingsBlob,
} from "./lib/account";
import {
  loadCatalog,
  loadHome,
  loadInstalledAddons,
  normalizeManifestUrl,
  resolveMeta,
  searchAddons,
} from "./lib/addons";
import {
  applyUpdate,
  checkForUpdate,
  subscribeUpdate,
  updateReady,
} from "./lib/appUpdate";
import {
  isAppleMobile,
  isDesktop,
  launchExternalPlayer,
} from "./lib/externalPlayer";
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
  Collection,
  CollectionFolder,
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

// Addons is deliberately absent: it is configuration, not a place you browse,
// so it lives behind Settings rather than taking a slot in the tab bar.
const nav: Array<{ key: NavKey; label: string; icon: typeof Home }> = [
  { key: "home", label: "Home", icon: Home },
  { key: "discover", label: "Discover", icon: Compass },
  { key: "library", label: "Library", icon: Library },
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
  // Read inside playback callbacks, which must see the latest rows to recover
  // the server's progress key rather than rebuilding it.
  const progressRef = useRef(progress);
  progressRef.current = progress;
  const [recentMetadata, setRecentMetadata] = useState<Meta[]>([]);
  const [settingsBlob, setSettingsBlob] = useState<SettingsBlob | null>(null);
  const [collections, setCollections] = useState<Collection[]>([]);
  const [homeLayout, setHomeLayout] = useState<HomeLayout | null>(null);
  const [folder, setFolder] = useState<CollectionFolder | null>(null);
  const [externalPlayer, setExternalPlayer] = useState<ExternalPlayerMode>(() => {
    const stored = localStorage.getItem(
      "nuvio-web-external-player",
    ) as ExternalPlayerMode | null;
    // The iOS-only schemes cannot work here, so an old choice would silently
    // do nothing. Copying is the desktop equivalent.
    if (isDesktop() && (stored === "vlc" || stored === "outplayer"))
      return "copy";
    return stored ?? "internal";
  });
  const [active, setActive] = useState<NavKey>("home");
  // The nav highlight follows `active` immediately; the page body renders from
  // the deferred copy, so a tap paints the new tab first and the heavy list
  // render happens in a later, interruptible pass instead of blocking it.
  const deferredActive = useDeferredValue(active);
  const [selected, setSelected] = useState<Meta | null>(null);
  const [catalog, setCatalog] = useState<CatalogSection | null>(null);
  // The sub-views are deferred for the same reason as the tab: leaving "See
  // all" rebuilds every home row, and without this the tap registered nothing
  // until that finished.
  const deferredCatalog = useDeferredValue(catalog);
  const deferredFolder = useDeferredValue(folder);

  // Opening a catalog or folder swaps the page content without touching the
  // document scroller, so a view entered from halfway down home opened
  // halfway down. Keyed on the deferred values so it fires with the render
  // that actually swaps the content, not one frame early.
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [deferredCatalog, deferredFolder, deferredActive]);
  const [playback, setPlayback] = useState<{
    stream: Stream;
    meta: Meta;
    video?: Video;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  // Status notices are informational, not decisions to act on, so they clear
  // themselves rather than sitting over the page until dismissed.
  useEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(""), 5000);
    return () => window.clearTimeout(timer);
  }, [message]);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Meta[]>([]);
  const [searching, setSearching] = useState(false);
  const [hasUpdate, setHasUpdate] = useState(updateReady);
  useEffect(() => subscribeUpdate(() => setHasUpdate(true)), []);
  // Ask once at startup rather than waiting for the browser's own schedule,
  // which can be hours — long enough to keep running a build you replaced.
  useEffect(() => {
    void checkForUpdate();
  }, []);
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
      const [
        rows,
        nextLibrary,
        nextProgress,
        nextWatched,
        blob,
        nextCollections,
        nextLayout,
      ] = await Promise.all([
          loadAddons(profile.profileIndex),
          loadLibrary(profile.profileIndex),
          loadProgress(profile.profileIndex),
          loadWatchedItems(profile.profileIndex).catch(() => []),
          // Neither of these may block the catalogs.
          loadSettingsBlob(profile.profileIndex).catch(() => null),
          loadCollections(profile.profileIndex).catch(() => []),
          loadHomeLayout(profile.profileIndex).catch(() => null),
        ]);
      setAddonRows(rows);
      setLibrary(nextLibrary);
      setProgress(nextProgress);
      setWatchedItems(nextWatched);
      if (blob) setSettingsBlob(blob);
      setCollections(nextCollections);
      setHomeLayout(nextLayout);
      const installed = await loadInstalledAddons(rows);
      setAddons(installed);
      // Rows appear as each batch lands instead of after every addon has
      // answered, which is what left the page blank on a slow connection.
      setSections([]);
      const home = await loadHome(
        installed,
        (section) => setSections((current) => [...current, section]),
        nextLayout,
      );
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
      // A title with no metadata is dropped from Continue Watching entirely,
      // so this cap is really a cap on how much of the list is shown. Twenty
      // was hiding rows for anyone with more in flight than that.
      const RESOLVE_LIMIT = 60;
      const RESOLVE_CONCURRENCY = 6;
      const pending = [...unique].slice(0, RESOLVE_LIMIT);
      const resolved: Meta[] = [];
      // Batched rather than one Promise.all over the whole set: sixty parallel
      // requests to a handful of addon hosts is how you get rate-limited.
      for (let cursor = 0; cursor < pending.length; cursor += RESOLVE_CONCURRENCY) {
        const batch = await Promise.all(
          pending
            .slice(cursor, cursor + RESOLVE_CONCURRENCY)
            .map(async ([id, identity]) => {
              const existing = known.get(id);
              if (existing?.videos.length) return existing;
              const seed: Meta = {
                id,
                type: identity.type,
                name:
                  watchedTitles.get(id) || existing?.name || "Recently watched",
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
        resolved.push(...batch);
        // Publish each batch so the row fills in rather than appearing whole
        // at the end.
        setRecentMetadata([...resolved]);
      }
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

  /**
   * Catalogs and collections in one list, ordered the way Nuvio stores them.
   *
   * They share a single ordering — collections keyed `collection_<id>`,
   * catalogs `<addon>:<type>:<catalog>` — so rendering all collections before
   * all catalogs ignored it entirely. That is why rows set to the bottom
   * appeared at the top.
   */
  const homeRows = useMemo(() => {
    type Row =
      | { key: string; kind: "catalog"; section: CatalogSection }
      | { key: string; kind: "collection"; collection: Collection };
    const rows: Row[] = [
      ...sections.map(
        (section) =>
          ({ key: section.key, kind: "catalog", section }) satisfies Row,
      ),
      ...collections
        .filter(
          (collection) =>
            homeLayout?.enabledOf.get(
              `${COLLECTION_KEY_PREFIX}${collection.id}`,
            ) !== false,
        )
        .map(
          (collection) =>
            ({
              key: `${COLLECTION_KEY_PREFIX}${collection.id}`,
              kind: "collection",
              collection,
            }) satisfies Row,
        ),
    ];
    if (!homeLayout) return rows;
    // Pinned collections are forced above everything, matching the desktop
    // client's `enforce_pinned_collections_at_top`. An unknown key sorts last:
    // it is new to this device rather than deliberately placed.
    const rank = (row: Row) =>
      row.kind === "collection" && row.collection.pinToTop
        ? -1
        : (homeLayout.orderOf.get(row.key) ?? Number.MAX_SAFE_INTEGER);
    return [...rows].sort((a, b) => rank(a) - rank(b));
  }, [collections, homeLayout, sections]);

  /**
   * Stores a resume point for whatever is playing.
   *
   * Fire-and-forget: a failed write must never interrupt playback, and the
   * next report a few seconds later supersedes it anyway. The local snapshot
   * is updated so Continue Watching reflects it without a refetch.
   */
  function savePlaybackProgress(
    current: { meta: Meta; video?: Video },
    positionMs: number,
    durationMs: number,
    ended: boolean,
  ) {
    if (!profile) return;
    const identity = {
      contentId: current.meta.id,
      contentType: current.meta.type,
      videoId: current.video?.id || current.meta.id,
      season: current.video?.season,
      episode: current.video?.episode,
    };
    const rows = progressRef.current;
    void pushProgress(
      profile.profileIndex,
      identity,
      positionMs,
      durationMs,
      ended,
      rows,
    )
      .then((stored) => {
        if (!stored) return;
        const complete = isComplete(positionMs, durationMs, ended);
        const key = watchKey(identity.contentId, identity.season, identity.episode);
        setProgress((currentRows) => [
          ...currentRows.filter(
            (row) => watchKey(row.contentId, row.season, row.episode) !== key,
          ),
          {
            contentId: identity.contentId,
            contentType: identity.contentType,
            videoId: identity.videoId,
            season: identity.season,
            episode: identity.episode,
            positionMs: complete && durationMs > 0 ? durationMs : positionMs,
            durationMs,
            lastWatched: Date.now(),
            progressKey: currentRows.find(
              (row) =>
                watchKey(row.contentId, row.season, row.episode) === key,
            )?.progressKey,
          },
        ]);
      })
      .catch(() => undefined);
  }

  /**
   * Adds or removes a title, flipping the button before the server answers and
   * restoring it if the write fails.
   */
  async function toggleLibrary(meta: Meta) {
    if (!profile) return;
    const present = library.some(
      (item) => item.id === meta.id && item.type === meta.type,
    );
    const previous = library;
    setLibrary((current) =>
      present
        ? current.filter(
            (item) => !(item.id === meta.id && item.type === meta.type),
          )
        : [...current, { ...meta, addedAt: Date.now() }],
    );
    try {
      if (present)
        await removeFromLibrary(profile.profileIndex, meta.id, meta.type);
      else await addToLibrary(profile.profileIndex, meta);
      setMessage(present ? "Removed from your library." : "Added to your library.");
    } catch (error) {
      setLibrary(previous);
      setMessage(
        error instanceof Error ? error.message : "Could not update your library",
      );
    }
  }

  /**
   * Carousel items, mirroring the desktop client's selection: round-robin
   * across the hero-source catalogs so the first addon does not own every
   * slot, skipping anything with no artwork, deduped, capped at 8.
   *
   * Which catalogs count as hero sources is a local preference on the other
   * clients, not part of the sync payload, so this uses their default — the
   * first two catalogs in the configured order.
   */
  const heroItems = useMemo(() => {
    const HERO_SOURCE_LIMIT = 2;
    const HERO_ITEM_LIMIT = 8;
    const sources = homeRows
      .filter((row) => row.kind === "catalog")
      .slice(0, HERO_SOURCE_LIMIT)
      .map((row) => (row.kind === "catalog" ? row.section : null))
      .filter((section): section is CatalogSection => section !== null);
    const seen = new Set<string>();
    const picked: Meta[] = [];
    const deepest = Math.max(0, ...sources.map((section) => section.items.length));
    for (let slot = 0; slot < deepest && picked.length < HERO_ITEM_LIMIT; slot += 1)
      for (const section of sources) {
        const item = section.items[slot];
        if (!item) continue;
        const identity = `${item.type}:${item.id}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
        if (!item.background && !item.banner && !item.poster) continue;
        picked.push(item);
        if (picked.length === HERO_ITEM_LIMIT) break;
      }
    return picked;
  }, [homeRows]);
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
        <img src={`${import.meta.env.BASE_URL}Nuvio-icon.png`} alt="" />
        <span>Restoring Nuvio…</span>
      </div>
    );
  if (!session) return <AuthScreen onSession={setSession} />;
  return (
    <div className="app-shell">
      <aside className="rail">
        <img src={`${import.meta.env.BASE_URL}Nuvio-icon.png`} alt="Nuvio" />
        {nav.map((item) => (
          <button
            key={item.key}
            className={active === item.key ? "active" : ""}
            title={item.label}
            onClick={() => {
              setActive(item.key);
              setCatalog(null);
              setFolder(null);
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
        {hasUpdate && (
          <div className="notice update-notice">
            <span>A new version of Nuvio Web is ready.</span>
            <button className="notice-action" onClick={() => applyUpdate()}>
              Reload
            </button>
            <button
              className="notice-dismiss"
              aria-label="Dismiss"
              onClick={() => setHasUpdate(false)}
            >
              <X size={18} />
            </button>
          </div>
        )}
        {message && (
          <div className="notice">
            <span>{message}</span>
            <button
              className="notice-dismiss"
              aria-label="Dismiss"
              onClick={() => setMessage("")}
            >
              <X size={18} />
            </button>
          </div>
        )}
        {(loading ||
          deferredActive !== active ||
          deferredCatalog !== catalog ||
          deferredFolder !== folder) && (
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
        {deferredFolder ? (
          <CollectionFolderView
            folder={deferredFolder}
            addons={addons}
            index={watchIndex}
            onBack={() => setFolder(null)}
            onOpen={setSelected}
          />
        ) : deferredCatalog ? (
          <CatalogView
            section={deferredCatalog}
            index={watchIndex}
            onBack={() => setCatalog(null)}
            onOpen={setSelected}
          />
        ) : deferredActive === "home" ? (
          <HomeView
            heroItems={heroItems}
            rows={homeRows}
            continueItems={continueItems}
            index={watchIndex}
            onOpen={setSelected}
            onSeeAll={setCatalog}
            onOpenFolder={setFolder}
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
            onBack={() => setActive("settings")}
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
            onAddons={() => setActive("addons")}
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
              setFolder(null);
            }}
          >
            <item.icon />
            <span>{item.label}</span>
          </button>
        ))}
      </nav>
      {playback && (
        /* An overlay rather than an early return: unmounting the shell to show
           the player threw away the resolved detail page, so closing it
           rebuilt home from scratch and only then re-opened details. */
        <Player
          {...playback}
          startPositionMs={(() => {
            const row = watchIndex.progress.get(
              watchKey(
                playback.meta.id,
                playback.video?.season,
                playback.video?.episode,
              ),
            );
            // A finished title starts over rather than resuming at the credits.
            if (!row || isComplete(row.positionMs, row.durationMs, false))
              return 0;
            return row.positionMs;
          })()}
          onClose={() => setPlayback(null)}
          onProgress={(positionMs, durationMs, ended) =>
            savePlaybackProgress(playback, positionMs, durationMs, ended)
          }
        />
      )}
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
          onLibrary={toggleLibrary}
          onPlay={(stream, meta, video) => {
            const url = stream.url || stream.externalUrl;
            if (externalPlayer !== "internal" && url) {
              launchExternalPlayer(
                externalPlayer,
                url,
                video?.title || meta.name,
              );
              setMessage(
                externalPlayer === "copy"
                  ? "Stream URL copied. Paste it into VLC or your media player to watch."
                  : externalPlayer === "m3u"
                    ? "Playlist downloaded. Open it with your preferred player."
                    : `Opening ${externalPlayer === "vlc" ? "VLC" : "Outplayer"}…`,
              );
              // Details stays open: the stream opened elsewhere, so this page
              // is exactly where you want to be when you come back.
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
type HomeRow =
  | { key: string; kind: "catalog"; section: CatalogSection }
  | { key: string; kind: "collection"; collection: Collection };

/**
 * Home renders progressively: each row is ~24 poster cards, so committing them
 * all at once is what delayed the tab switch.
 */
function HomeView({
  heroItems,
  rows,
  continueItems,
  index,
  onOpen,
  onSeeAll,
  onOpenFolder,
}: {
  heroItems: Meta[];
  rows: HomeRow[];
  continueItems: ReturnType<typeof buildContinueWatching>;
  index: WatchIndex;
  onOpen(item: Meta): void;
  onSeeAll(section: CatalogSection): void;
  onOpenFolder(folder: CollectionFolder): void;
}) {
  const { visible } = useProgressiveList(rows, {
    resetKey: "home",
    first: 3,
    chunk: 2,
  });
  return (
    <>
      <Hero items={heroItems} onOpen={onOpen} />
      {continueItems.length > 0 && (
        <ContinueWatching cards={continueItems} onOpen={onOpen} />
      )}
      {visible.map((row) =>
        row.kind === "collection" ? (
          <CollectionRow
            key={row.key}
            collection={row.collection}
            onOpenFolder={onOpenFolder}
          />
        ) : (
          <MediaRow
            key={row.key}
            section={row.section}
            index={index}
            onOpen={onOpen}
            onSeeAll={() => onSeeAll(row.section)}
          />
        ),
      )}
    </>
  );
}

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
  const { visible } = useProgressiveList(filtered, { resetKey: tab });
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
  const [items, setItems] = useState<Meta[]>(section.items);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const [error, setError] = useState("");
  const sentinel = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setItems(section.items);
    setExhausted(false);
    setError("");
  }, [section]);

  const more = useCallback(async () => {
    if (loadingMore || exhausted) return;
    setLoadingMore(true);
    try {
      const next = await loadCatalog(section, items.length);
      // Addons that ignore `skip` return the same page forever, so anything
      // that adds no new ids ends the run rather than looping.
      const known = new Set(items.map((item) => `${item.type}:${item.id}`));
      const additions = next.filter(
        (item) => !known.has(`${item.type}:${item.id}`),
      );
      if (additions.length === 0) setExhausted(true);
      else setItems((current) => [...current, ...additions]);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Could not load more",
      );
      setExhausted(true);
    } finally {
      setLoadingMore(false);
    }
  }, [exhausted, items, loadingMore, section]);

  // Infinite scroll rather than a button: the sentinel sits below the grid and
  // fetches the next page as it comes into view.
  useEffect(() => {
    const node = sentinel.current;
    if (!node || exhausted) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) more();
      },
      { rootMargin: "600px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [more, exhausted]);

  const { visible } = useProgressiveList(items, { resetKey: section.key });
  return (
    <section className="grid-page">
      <div className="page-head">
        <button
          className="circle-button"
          aria-label="Back"
          title="Back"
          onClick={onBack}
        >
          <ArrowLeft />
        </button>
        <div>
          <span className="eyebrow">{section.addonName}</span>
          <h1>{section.name}</h1>
          <p>
            {section.type === "series" ? "Series" : "Movies"} · {items.length}{" "}
            titles
          </p>
        </div>
      </div>
      {error && <div className="notice error">{error}</div>}
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
      {!exhausted && <div ref={sentinel} className="grid-sentinel" />}
      {loadingMore && (
        <div className="grid-more" role="status">
          <i className="mini-spinner" />
          Loading more…
        </div>
      )}
    </section>
  );
}

function AddonsPage({
  addons,
  rows,
  onBack,
  onToggle,
  onAdd,
  onRefresh,
}: {
  addons: InstalledAddon[];
  rows: AddonRow[];
  onBack(): void;
  onToggle(index: number): void;
  onAdd(url: string): Promise<void>;
  onRefresh(): void;
}) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  return (
    <section className="settings-page">
      <div className="page-head">
        <button
          className="circle-button"
          aria-label="Back to settings"
          title="Back to settings"
          onClick={onBack}
        >
          <ArrowLeft />
        </button>
        <div>
          <span className="eyebrow">CONTENT</span>
          <h1>Addons</h1>
          <p>
            These are synced with the selected Nuvio profile. Catalog requests
            go straight from this device to each addon.
          </p>
        </div>
      </div>
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
/**
 * Manual update check. The worker only polls on its own schedule, which can be
 * hours; this asks immediately. A found update raises the usual reload prompt
 * rather than restarting the app from under you.
 */
function UpdateRow() {
  const [state, setState] = useState<"idle" | "checking" | "current" | "pending">(
    "idle",
  );
  return (
    <>
      <div className="theme-row">
        <span>
          <strong>Check for updates</strong>
          <small>
            {state === "checking"
              ? "Checking…"
              : state === "current"
                ? "You are on the latest version."
                : state === "pending"
                  ? "An update is ready — use the Reload bar at the top."
                  : `Build ${new Date(__APP_BUILD__).toLocaleString()}`}
          </small>
        </span>
        <button
          className="secondary"
          disabled={state === "checking"}
          onClick={async () => {
            setState("checking");
            const result = await checkForUpdate();
            setState(result === "pending" ? "pending" : "current");
          }}
        >
          <RefreshCw size={16} /> Check
        </button>
      </div>
      {state === "pending" && (
        <button className="primary wide" onClick={() => applyUpdate()}>
          Reload now
        </button>
      )}
    </>
  );
}

function SettingsPage({
  onAddons,
  session,
  profile,
  amoled,
  amoledReady,
  onAmoled,
  externalPlayer,
  onExternalPlayer,
  onSignOut,
}: {
  onAddons(): void;
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
      <button className="setting-link" onClick={onAddons}>
        <Puzzle />
        <span>
          <strong>Addons</strong>
          <small>Install, reorder and disable your Stremio addons</small>
        </span>
        <ChevronRight />
      </button>
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
              {isDesktop()
                ? "Desktop browsers cannot launch a local player, so Nuvio copies the stream URL for you to paste into VLC. For proper desktop playback, use the Nuvio desktop app."
                : "VLC and Outplayer open through their iOS URL schemes."}
            </small>
          </span>
          <select
            value={externalPlayer}
            onChange={(event) =>
              onExternalPlayer(event.target.value as ExternalPlayerMode)
            }
          >
            <option value="internal">Nuvio web player</option>
            {isDesktop() ? (
              <option value="copy">Copy link for an external player</option>
            ) : (
              <>
                <option value="vlc">VLC</option>
                <option value="outplayer">Outplayer (iOS/iPadOS)</option>
              </>
            )}
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
          <h2>App version</h2>
        </header>
        <UpdateRow />
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
