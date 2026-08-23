import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ImgHTMLAttributes,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import { plex } from "../plex.ts";
import {
  artworkAttemptKey,
  artworkRequestKey,
  artworkUrlForKey,
  normalizeArtworkSource,
  normalizeArtworkVariant,
  RendererArtworkStore,
  TRANSCODED_FALLBACK_VARIANT,
  type ArtworkRequest,
  type ArtworkRequestSource,
} from "./index.ts";
import type { ArtworkVariant } from "../../bun/plex/artwork/types.ts";

const requestArtwork: ArtworkRequest = (source, variant) =>
  source.kind === "server"
    ? plex.getArtwork(source.path, variant)
    : plex.getAccountArtwork(variant);

export const rendererArtworkStore = new RendererArtworkStore(requestArtwork);

export interface ArtworkImageProps extends Omit<
  ImgHTMLAttributes<HTMLImageElement>,
  "src" | "loading" | "onError"
> {
  source: ArtworkRequestSource;
  variant?: ArtworkVariant;
  /** Bypass viewport gating for visible detail and playback artwork. */
  priority?: boolean;
  /** Existing fallback content remains in the same wrapper as the image. */
  fallback?: ReactNode;
  fallbackClassName?: string;
  onError?: (event: SyntheticEvent<HTMLImageElement, Event>) => void;
}

/**
 * Shared token-free Plex artwork image. The fallback span is also the
 * IntersectionObserver target, so a non-priority image cannot start its RPC
 * until it is near the viewport. `loading="lazy"` remains only a browser hint.
 */
export function ArtworkImage({
  source,
  variant,
  priority = false,
  fallback,
  fallbackClassName,
  onError,
  alt,
  ...imageProps
}: ArtworkImageProps) {
  const normalizedSource = useMemo(
    () => normalizeArtworkSource(source),
    [source?.kind, source?.kind === "server" ? source.path : undefined],
  );
  const normalizedVariant = useMemo(() => normalizeArtworkVariant(variant), [variant]);
  const requestKey = normalizedSource ? artworkRequestKey(normalizedSource, normalizedVariant) : "";
  const [loadKey, setLoadKey] = useState<string | null>(null);
  const [loadedImage, setLoadedImage] = useState<{ key: string; url: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const targetRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    setLoadedImage(null);
    setAttempt(0);
    setLoadKey(priority && requestKey ? requestKey : null);
  }, [priority, requestKey]);

  useEffect(() => {
    if (!normalizedSource || priority || !requestKey) return;
    const target = targetRef.current;
    if (typeof IntersectionObserver === "undefined" || !target) {
      setLoadKey(requestKey);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting || entry.intersectionRatio > 0)) {
          setLoadKey(requestKey);
          observer.disconnect();
        }
      },
      { rootMargin: "400px 0px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [normalizedSource, priority, requestKey]);

  useEffect(() => {
    if (!normalizedSource || loadKey !== requestKey || !requestKey) return;
    const variant = attempt === 0 ? normalizedVariant : TRANSCODED_FALLBACK_VARIANT;
    const loadAttemptKey = artworkAttemptKey(normalizedSource, variant, attempt);
    const acquired = rendererArtworkStore.acquire(normalizedSource, variant);
    let active = true;
    void acquired.promise.then((url) => {
      if (active && url) setLoadedImage({ key: loadAttemptKey, url });
    });
    return () => {
      active = false;
      acquired.release();
    };
  }, [attempt, loadKey, normalizedSource, normalizedVariant, requestKey]);

  const handleError = (event: SyntheticEvent<HTMLImageElement, Event>) => {
    if (attempt === 0 && normalizedSource) {
      setLoadedImage(null);
      setAttempt(1);
      return;
    }
    setLoadedImage(null);
    onError?.(event);
  };

  const activeVariant = attempt === 0 ? normalizedVariant : TRANSCODED_FALLBACK_VARIANT;
  const activeImageKey =
    normalizedSource && loadKey === requestKey
      ? artworkAttemptKey(normalizedSource, activeVariant, attempt)
      : "";
  const imageSrc = artworkUrlForKey(loadedImage, activeImageKey);

  return (
    <>
      <span ref={targetRef} className={fallbackClassName} hidden={Boolean(imageSrc)}>
        {fallback}
      </span>
      {imageSrc && (
        <img {...imageProps} src={imageSrc} alt={alt} loading="lazy" onError={handleError} />
      )}
    </>
  );
}
