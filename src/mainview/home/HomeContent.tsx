import { ArtworkImage } from "../artwork/ArtworkImage.tsx";
import {
  filterMusicHomeHubs,
  HOME_HUB_PREVIEW_SIZE,
  homeCategoryItemMeta,
  homeHubItemMeta,
  homeHubItemInteraction,
  shouldShowHomeHubSeeAll,
} from "./utils.ts";
import type { HomeStateSnapshot } from "./state.ts";
import { Icon } from "../components/Icon.tsx";
import type { PlexHub, PlexHubItem } from "../../bun/plex/types.ts";

export type HomeCategoryView = {
  hub: PlexHub;
  items: PlexHubItem[];
  status: "loading" | "ready" | "error";
  error: string | null;
};

export function MediaCard({
  item,
  category,
  onPlay,
  onAlbum,
  onArtist,
  onPlaylist,
  meta,
}: {
  item: PlexHubItem;
  category?: boolean;
  onPlay?: () => void;
  onAlbum?: (item: PlexHubItem) => void;
  onArtist?: (item: PlexHubItem) => void;
  onPlaylist?: (item: PlexHubItem) => void;
  meta?: string;
}) {
  const path = item.thumb ?? item.composite ?? item.art;
  const interaction = homeHubItemInteraction(item);
  const canOpenAlbum = item.type === "album" && Boolean(onAlbum);
  const canOpenArtist = item.type === "artist" && Boolean(onArtist);
  const canOpenPlaylist = item.type === "playlist" && Boolean(onPlaylist);
  const openAlbum = () => onAlbum?.(item);
  const openArtist = () => onArtist?.(item);
  const openPlaylist = () => onPlaylist?.(item);

  const cardContent = (
    <>
      <div className="home-hub-card-art">
        <ArtworkImage
          source={path ? { kind: "server", path } : null}
          alt=""
          fallback={item.title.charAt(0).toUpperCase() || "♪"}
          fallbackClassName="home-hub-card-art-fallback"
        />
        {interaction === "track" && (
          <button
            className="home-hub-card-play"
            type="button"
            aria-label={`Play ${item.title}`}
            disabled={!onPlay}
            onClick={(event) => {
              event.stopPropagation();
              onPlay?.();
            }}
          >
            <Icon>
              <path d="m8 5 11 7-11 7z" />
            </Icon>
          </button>
        )}
      </div>
      <div className="home-hub-card-text">
        <span className="home-hub-card-title">{item.title}</span>
        <span className="home-hub-card-meta">
          {meta ?? (category ? homeCategoryItemMeta(item) : homeHubItemMeta(item))}
        </span>
      </div>
    </>
  );

  return (
    <li
      className={`home-hub-card${category ? " home-category-card" : ""} home-hub-card-${interaction}`}
    >
      {canOpenAlbum ? (
        <button
          className="home-hub-card-album"
          type="button"
          aria-label={`Open album ${item.title}`}
          onClick={openAlbum}
        >
          {cardContent}
        </button>
      ) : canOpenArtist ? (
        <button
          className="home-hub-card-album"
          type="button"
          aria-label={`Open artist ${item.title}`}
          onClick={openArtist}
        >
          {cardContent}
        </button>
      ) : canOpenPlaylist ? (
        <button
          className="home-hub-card-album"
          type="button"
          aria-label={`Open playlist ${item.title}`}
          onClick={openPlaylist}
        >
          {cardContent}
        </button>
      ) : (
        cardContent
      )}
    </li>
  );
}

export function HomeCategory({
  view,
  onAlbum,
  onArtist,
  onPlay,
  onPlaylist,
}: {
  view: HomeCategoryView;
  onAlbum: (item: PlexHubItem) => void;
  onArtist: (item: PlexHubItem) => void;
  onPlay: (item: PlexHubItem) => void;
  onPlaylist: (item: PlexHubItem) => void;
}) {
  return (
    <div className="home-category" id="home-category">
      <header className="home-category-header">
        <h2 className="home-category-title" id="home-category-title">
          {view.hub.title ?? view.hub.hubIdentifier ?? "Plex category"}
        </h2>
      </header>
      <div
        className="home-category-status"
        id="home-category-status"
        aria-live="polite"
        hidden={view.status === "ready" && view.items.length > 0}
      >
        {view.status === "loading"
          ? "Loading…"
          : view.status === "error"
            ? `Couldn't load this category${view.error ? `: ${view.error}` : "."}`
            : "No items in this category."}
      </div>
      <ul className="home-category-cards" id="home-category-cards">
        {view.status === "ready" &&
          view.items.map((item) => (
            <MediaCard
              item={item}
              category
              onAlbum={onAlbum}
              onArtist={onArtist}
              onPlaylist={onPlaylist}
              onPlay={() => onPlay(item)}
              key={`${item.ratingKey ?? item.title}`}
            />
          ))}
      </ul>
    </div>
  );
}

export function HomeDashboard({
  state,
  onRetry,
  onCategory,
  onAlbum,
  onArtist,
  onPlay,
  onPlaylist,
}: {
  state: HomeStateSnapshot;
  onRetry: () => void;
  onCategory: (hub: PlexHub) => void;
  onAlbum: (item: PlexHubItem) => void;
  onArtist: (item: PlexHubItem) => void;
  onPlay: (item: PlexHubItem) => void;
  onPlaylist: (item: PlexHubItem) => void;
}) {
  const hubs = filterMusicHomeHubs(state.hubs);

  return (
    <div className="home-dashboard" id="home-dashboard">
      <div
        className={`home-state${state.status === "error" ? " is-error" : ""}`}
        id="home-state"
        aria-live="polite"
        hidden={state.status !== "loading" && state.status !== "error"}
      >
        {state.status === "loading"
          ? "Loading your Plex home…"
          : state.status === "error"
            ? state.error
              ? `Couldn't load your Plex home: ${state.error}`
              : "Couldn't load your Plex home."
            : ""}
      </div>
      {state.status === "error" && (
        <button className="home-retry" id="home-retry" type="button" onClick={onRetry}>
          Try again
        </button>
      )}
      {state.status === "ready" && hubs.length === 0 && (
        <div className="home-empty" id="home-empty">
          <h3>No music rows yet</h3>
          <p>Plex has not returned any music recommendations for this server.</p>
        </div>
      )}
      <div className="home-hub-rows" id="home-hub-rows">
        {state.status === "ready" &&
          hubs.map((hub) => (
            <section className="home-hub-row" key={hub.hubIdentifier ?? hub.key ?? hub.title}>
              <div className="home-hub-heading">
                <h3 className="home-hub-title">{hub.title ?? hub.hubIdentifier ?? "Plex Home"}</h3>
                {shouldShowHomeHubSeeAll(hub) && (hub.hubIdentifier ?? hub.key) && (
                  <button
                    className="home-hub-see-all"
                    type="button"
                    onClick={() => onCategory(hub)}
                  >
                    See all
                  </button>
                )}
              </div>
              <ul className="home-hub-cards">
                {(hub.Metadata ?? []).slice(0, HOME_HUB_PREVIEW_SIZE).map((item) => (
                  <MediaCard
                    item={item}
                    onAlbum={onAlbum}
                    onArtist={onArtist}
                    onPlaylist={onPlaylist}
                    onPlay={() => onPlay(item)}
                    key={`${item.ratingKey ?? item.title}`}
                  />
                ))}
              </ul>
            </section>
          ))}
      </div>
    </div>
  );
}
