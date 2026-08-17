import {
  ArrowDown,
  ArrowUp,
  Puzzle,
  RefreshCw,
  Settings,
  TestTube2,
  Trash2,
  X,
} from "lucide-react";
import { useState } from "react";
import {
  pluginSettingsLayout,
  readPluginSettings,
  savePluginSettings,
  testPluginScraper,
} from "../lib/plugins";
import type { PluginScraper, PluginState } from "../types";

export function PluginSettings({
  state,
  ready,
  readOnly = false,
  onState,
  onAdd,
  onRefresh,
  onRemove,
  onMove,
}: {
  state: PluginState;
  ready: boolean;
  readOnly?: boolean;
  onState(next: PluginState): void;
  onAdd(url: string): Promise<void>;
  onRefresh(url: string): Promise<void>;
  onRemove(url: string): void;
  onMove(index: number, direction: -1 | 1): void;
}) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const [busyUrl, setBusyUrl] = useState("");
  const [configuring, setConfiguring] = useState<{
    scraper: PluginScraper;
    layout: Array<Record<string, unknown>>;
    values: Record<string, unknown>;
  } | null>(null);
  const [testing, setTesting] = useState("");
  const [testMessage, setTestMessage] = useState<Record<string, string>>({});

  const setScraperEnabled = (id: string, enabled: boolean) => {
    onState({
      ...state,
      scrapers: state.scrapers.map((scraper) =>
        scraper.id === id
          ? { ...scraper, enabled: scraper.manifestEnabled && enabled }
          : scraper,
      ),
    });
  };

  return (
    <>
      <div className="plugin-global-settings setting-card compact-setting-card">
        <SettingSwitch
          title="Enable plugins"
          description="Include enabled plugin providers when fetching sources."
          checked={state.pluginsEnabled}
          disabled={!ready || readOnly}
          onChange={(pluginsEnabled) => onState({ ...state, pluginsEnabled })}
        />
        <SettingSwitch
          title="Group streams by repository"
          description="Combine providers from the same repository into one source group."
          checked={state.groupStreamsByRepository}
          disabled={!ready || readOnly}
          onChange={(groupStreamsByRepository) =>
            onState({ ...state, groupStreamsByRepository })
          }
        />
      </div>
      <form
        className="addon-install"
        onSubmit={async (event) => {
          event.preventDefault();
          setError("");
          setBusyUrl(url);
          try {
            await onAdd(url);
            setUrl("");
          } catch (reason) {
            setError(
              reason instanceof Error
                ? reason.message
                : "Could not install plugin repository.",
            );
          } finally {
            setBusyUrl("");
          }
        }}
      >
        <input
          type="url"
          value={url}
          disabled={!ready || readOnly || !!busyUrl}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://plugins.example/manifest.json"
        />
        <button
          className="primary"
          disabled={!ready || readOnly || !url.trim() || !!busyUrl}
        >
          {busyUrl ? "Installing…" : "Install"}
        </button>
      </form>
      {error && <div className="notice error">{error}</div>}
      {readOnly && (
        <div className="notice">
          This profile uses the primary profile&apos;s plugins. Switch to the
          primary profile to install, remove, or configure providers.
        </div>
      )}
      <div className="notice plugin-browser-note">
        Plugins run inside an isolated browser sandbox. Providers that depend
        on Node.js or websites without browser CORS access may still require
        the desktop app.
      </div>
      <div className="addon-list-heading">
        <h2>Plugin repositories</h2>
        <span>{state.repositories.length} installed</span>
      </div>
      <div className="plugin-repository-list">
        {state.repositories.map((repository, repositoryIndex) => {
          const scrapers = state.scrapers.filter(
            (scraper) => scraper.repositoryUrl === repository.manifestUrl,
          );
          return (
            <article className="plugin-repository-card" key={repository.manifestUrl}>
              <header>
                <span className="addon-card-icon"><Puzzle /></span>
                <div>
                  <strong>{repository.name}</strong>
                  <small>
                    {repository.version ? `Version ${repository.version} · ` : ""}
                    {scrapers.length} provider{scrapers.length === 1 ? "" : "s"}
                  </small>
                </div>
                <span className="plugin-repository-order" aria-label={`${repository.name} order controls`}>
                  <button
                    className="addon-action"
                    aria-label={`Move ${repository.name} up`}
                    title="Move repository up"
                    disabled={readOnly || repositoryIndex === 0}
                    onClick={() => onMove(repositoryIndex, -1)}
                  >
                    <ArrowUp />
                  </button>
                  <button
                    className="addon-action"
                    aria-label={`Move ${repository.name} down`}
                    title="Move repository down"
                    disabled={readOnly || repositoryIndex === state.repositories.length - 1}
                    onClick={() => onMove(repositoryIndex, 1)}
                  >
                    <ArrowDown />
                  </button>
                </span>
                <button
                  className="addon-action refresh-icon"
                  aria-label={`Refresh ${repository.name}`}
                  title="Refresh repository"
                  disabled={readOnly || busyUrl === repository.manifestUrl}
                  onClick={async () => {
                    setBusyUrl(repository.manifestUrl);
                    setError("");
                    try {
                      await onRefresh(repository.manifestUrl);
                    } catch (reason) {
                      setError(reason instanceof Error ? reason.message : "Refresh failed.");
                    } finally {
                      setBusyUrl("");
                    }
                  }}
                >
                  <RefreshCw className={busyUrl === repository.manifestUrl ? "spin-icon" : ""} />
                </button>
                <button
                  className="addon-action danger-icon"
                  aria-label={`Remove ${repository.name}`}
                  title="Remove repository"
                  disabled={readOnly}
                  onClick={() => {
                    if (window.confirm(`Remove ${repository.name} and its providers?`))
                      onRemove(repository.manifestUrl);
                  }}
                >
                  <Trash2 />
                </button>
              </header>
              {repository.description && <p>{repository.description}</p>}
              {repository.error && <div className="plugin-error">{repository.error}</div>}
              <div className="plugin-scraper-list">
                {scrapers.map((scraper) => (
                  <div
                    className={scraper.enabled ? "plugin-scraper" : "plugin-scraper is-disabled"}
                    key={scraper.id}
                  >
                    {scraper.logo ? (
                      <img src={scraper.logo} alt="" />
                    ) : (
                      <span className="plugin-provider-fallback">
                        {scraper.name.slice(0, 1).toUpperCase()}
                      </span>
                    )}
                    <span className="plugin-scraper-copy">
                      <strong>{scraper.name}</strong>
                      <small>
                        {scraper.description || scraper.supportedTypes.join(" / ")}
                      </small>
                      {testMessage[scraper.id] && <em>{testMessage[scraper.id]}</em>}
                    </span>
                    {scraper.hasSettings && (
                      <button
                        className="addon-action"
                        title="Provider settings"
                        aria-label={`${scraper.name} settings`}
                        disabled={readOnly}
                        onClick={async () => {
                          setError("");
                          try {
                            const [layout, values] = await Promise.all([
                              pluginSettingsLayout(scraper),
                              readPluginSettings(scraper.id),
                            ]);
                            setConfiguring({ scraper, layout, values });
                          } catch (reason) {
                            setError(reason instanceof Error ? reason.message : "Settings failed to load.");
                          }
                        }}
                      >
                        <Settings />
                      </button>
                    )}
                    <button
                      className="addon-action"
                      title="Test provider"
                      aria-label={`Test ${scraper.name}`}
                      disabled={testing === scraper.id}
                      onClick={async () => {
                        setTesting(scraper.id);
                        setTestMessage((current) => ({ ...current, [scraper.id]: "Testing…" }));
                        try {
                          const supportsMovie = scraper.supportedTypes.some(
                            (value) => value.toLowerCase() === "movie",
                          );
                          const streams = await testPluginScraper(
                            scraper,
                            "603",
                            supportsMovie ? "movie" : "tv",
                            supportsMovie ? undefined : 1,
                            supportsMovie ? undefined : 1,
                          );
                          setTestMessage((current) => ({
                            ...current,
                            [scraper.id]: `${streams.length} stream${streams.length === 1 ? "" : "s"} returned`,
                          }));
                        } catch (reason) {
                          setTestMessage((current) => ({
                            ...current,
                            [scraper.id]: reason instanceof Error ? reason.message : "Test failed.",
                          }));
                        } finally {
                          setTesting("");
                        }
                      }}
                    >
                      <TestTube2 />
                    </button>
                    <label className="switch">
                      <input
                        type="checkbox"
                        aria-label={`Enable ${scraper.name}`}
                        checked={scraper.enabled}
                        disabled={readOnly || !scraper.manifestEnabled}
                        onChange={(event) =>
                          setScraperEnabled(scraper.id, event.target.checked)
                        }
                      />
                      <i />
                    </label>
                  </div>
                ))}
              </div>
            </article>
          );
        })}
        {ready && state.repositories.length === 0 && (
          <div className="empty compact-empty">
            <Puzzle />
            <strong>No plugin repositories installed</strong>
            <span>Add a Nuvio plugin manifest URL above.</span>
          </div>
        )}
      </div>
      {configuring && (
        <PluginSettingsDialog
          scraper={configuring.scraper}
          layout={configuring.layout}
          initialValues={configuring.values}
          onClose={() => setConfiguring(null)}
        />
      )}
    </>
  );
}

function SettingSwitch({
  title,
  description,
  checked,
  disabled,
  onChange,
}: {
  title: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange(value: boolean): void;
}) {
  return (
    <label className="theme-row">
      <span><strong>{title}</strong><small>{description}</small></span>
      <span className="switch">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        <i />
      </span>
    </label>
  );
}

function PluginSettingsDialog({
  scraper,
  layout,
  initialValues,
  onClose,
}: {
  scraper: PluginScraper;
  layout: Array<Record<string, unknown>>;
  initialValues: Record<string, unknown>;
  onClose(): void;
}) {
  const [values, setValues] = useState(initialValues);
  const [saving, setSaving] = useState(false);
  const valueFor = (field: Record<string, unknown>) => {
    const key = String(field.key ?? "");
    return values[key] ?? field.defaultValue ?? (field.type === "toggle" ? false : "");
  };
  return (
    <div className="plugin-dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="plugin-dialog" role="dialog" aria-modal="true" aria-labelledby="plugin-dialog-title">
        <header>
          <div><span>PLUGIN PROVIDER</span><h2 id="plugin-dialog-title">{scraper.name} settings</h2></div>
          <button className="circle-button" aria-label="Close" onClick={onClose}><X /></button>
        </header>
        <div className="plugin-dialog-fields">
          {layout.map((field, index) => {
            const type = String(field.type ?? "info");
            const key = String(field.key ?? "");
            const label = String(field.label ?? "");
            const description = field.description ? String(field.description) : "";
            if (type === "header") return <h3 key={`${type}:${index}`}>{label}</h3>;
            if (type === "info") return <p key={`${type}:${index}`} className="plugin-field-info">{label}</p>;
            if (type === "toggle") return (
              <SettingSwitch
                key={`${key}:${index}`}
                title={label}
                description={description}
                checked={valueFor(field) === true}
                onChange={(value) => setValues((current) => ({ ...current, [key]: value }))}
              />
            );
            if (type === "select") {
              const options = Array.isArray(field.options)
                ? field.options.filter((option): option is Record<string, unknown> => !!option && typeof option === "object")
                : [];
              return (
                <label className="plugin-field" key={`${key}:${index}`}>
                  <strong>{label}</strong>
                  <select
                    value={String(valueFor(field))}
                    onChange={(event) => setValues((current) => ({ ...current, [key]: event.target.value }))}
                  >
                    {options.map((option, optionIndex) => (
                      <option value={String(option.value ?? "")} key={`${String(option.value)}:${optionIndex}`}>
                        {String(option.label ?? option.value ?? "")}
                      </option>
                    ))}
                  </select>
                  {description && <small>{description}</small>}
                </label>
              );
            }
            if (type === "text") return (
              <label className="plugin-field" key={`${key}:${index}`}>
                <strong>{label}</strong>
                <input
                  type={field.isPassword === true ? "password" : "text"}
                  value={String(valueFor(field))}
                  placeholder={String(field.placeholder ?? "")}
                  autoComplete={field.isPassword === true ? "off" : undefined}
                  onChange={(event) => setValues((current) => ({ ...current, [key]: event.target.value }))}
                />
                {description && <small>{description}</small>}
              </label>
            );
            return null;
          })}
          {layout.length === 0 && <p className="plugin-field-info">This provider did not return any configurable fields.</p>}
        </div>
        <footer>
          <button className="secondary" onClick={onClose}>Cancel</button>
          <button
            className="primary"
            disabled={saving}
            onClick={async () => {
              setSaving(true);
              try {
                await savePluginSettings(scraper.id, values);
                onClose();
              } finally {
                setSaving(false);
              }
            }}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </footer>
      </section>
    </div>
  );
}
