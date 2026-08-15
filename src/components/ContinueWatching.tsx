import type { ContinueCard } from "../lib/progress";
import { progressPercent, remainingLabel } from "../lib/progress";
import { useDragScroll } from "../lib/useDragScroll";

export function ContinueWatching({
  cards,
  onOpen,
}: {
  cards: ContinueCard[];
  onOpen(item: ContinueCard["item"]): void;
}) {
  const rowRef = useDragScroll<HTMLDivElement>();
  return (
    <section className="media-section continue-section">
      <header>
        <div>
          <h2>Continue watching</h2>
          <span>Synced from Nuvio</span>
        </div>
      </header>
      <div className="continue-row" ref={rowRef}>
        {cards.map((card) => {
          const artwork =
            card.video?.thumbnail ||
            card.item.background ||
            card.item.banner ||
            card.item.poster;
          const progress = progressPercent(card);
          const selected = card.video
            ? { ...card.item, selectedVideoId: card.video.id }
            : card.item;
          return (
            <button
              className="continue-card"
              key={`${card.item.id}:${card.video?.id || card.progress?.videoId || "next"}`}
              onClick={() => onOpen(selected)}
            >
              <span
                className="continue-art"
                style={
                  artwork
                    ? {
                        backgroundImage: `url("${artwork.replace(/"/g, "%22")}")`,
                      }
                    : undefined
                }
              >
                <i className="continue-badge">
                  {card.nextUp ? "Next up" : remainingLabel(card.progress)}
                </i>
                <span className="continue-copy">
                  {card.video?.season != null &&
                    card.video?.episode != null && (
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
