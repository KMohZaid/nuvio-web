import type { ContinueCard } from "../lib/progress";
import { progressPercent, remainingLabel } from "../lib/progress";
import type { ContinueWatchingSettings } from "../lib/webSettings";
import { useDragScroll } from "../lib/useDragScroll";

const futureNextUp = (card: ContinueCard) => {
  if (!card.nextUp || !card.video?.released) return false;
  const released = new Date(card.video.released).getTime();
  return Number.isFinite(released) && released > Date.now();
};

function artworkFor(card: ContinueCard, settings: ContinueWatchingSettings) {
  if (settings.style === "Poster")
    return (
      card.item.poster ||
      card.item.background ||
      card.item.banner ||
      (settings.useEpisodeThumbnails ? card.video?.thumbnail : undefined)
    );
  if (settings.useEpisodeThumbnails)
    return (
      card.video?.thumbnail ||
      card.item.background ||
      card.item.banner ||
      card.item.poster
    );
  return (
    card.item.background ||
    card.item.banner ||
    card.item.poster ||
    card.video?.thumbnail
  );
}

function ContinueRow({
  title,
  cards,
  settings,
  onOpen,
}: {
  title: string;
  cards: ContinueCard[];
  settings: ContinueWatchingSettings;
  onOpen(item: ContinueCard["item"]): void;
}) {
  const rowRef = useDragScroll<HTMLDivElement>();
  if (!cards.length) return null;
  return (
    <section className="media-section continue-section">
      <header>
        <h2>{title}</h2>
      </header>
      <div className="continue-row" ref={rowRef}>
        {cards.map((card) => {
          const artwork = artworkFor(card, settings);
          const progress = progressPercent(card);
          const selected = card.video
            ? { ...card.item, selectedVideoId: card.video.id }
            : card.item;
          const blur =
            settings.blurNextUp &&
            settings.useEpisodeThumbnails &&
            card.nextUp;
          return (
            <button
              className={`continue-card style-${settings.style.toLowerCase()}`}
              key={`${card.item.id}:${card.video?.id || card.progress?.videoId || "next"}`}
              onClick={() => onOpen(selected)}
            >
              <span className="continue-art">
                <span
                  className={`continue-image${blur ? " is-blurred" : ""}`}
                  style={
                    artwork
                      ? {
                          backgroundImage: `url("${artwork.replace(/"/g, "%22")}")`,
                        }
                      : undefined
                  }
                />
                <i className="continue-badge">
                  {card.nextUp ? "Next up" : remainingLabel(card.progress)}
                </i>
                <span className="continue-copy">
                  {card.video?.season != null && card.video?.episode != null && (
                    <small>
                      S{card.video.season} E{card.video.episode}
                    </small>
                  )}
                  <strong>{card.item.name}</strong>
                  {card.video?.title && <em>{card.video.title}</em>}
                </span>
                {progress > 0 && (
                  <span className="continue-progress">
                    <b style={{ width: `${progress}%` }} />
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

export function ContinueWatching({
  cards,
  settings,
  onOpen,
}: {
  cards: ContinueCard[];
  settings: ContinueWatchingSettings;
  onOpen(item: ContinueCard["item"]): void;
}) {
  if (!settings.isVisible) return null;
  if (settings.sortMode !== "SPLIT_UPCOMING")
    return (
      <ContinueRow
        title="Continue watching"
        cards={cards}
        settings={settings}
        onOpen={onOpen}
      />
    );
  const upcoming = cards.filter(futureNextUp).sort((left, right) => {
    const leftDate = new Date(left.video?.released || "").getTime();
    const rightDate = new Date(right.video?.released || "").getTime();
    return leftDate - rightDate;
  });
  const current = cards.filter((card) => !futureNextUp(card));
  return (
    <>
      <ContinueRow
        title="Continue watching"
        cards={current}
        settings={settings}
        onOpen={onOpen}
      />
      <ContinueRow
        title="Upcoming"
        cards={upcoming}
        settings={settings}
        onOpen={onOpen}
      />
    </>
  );
}
