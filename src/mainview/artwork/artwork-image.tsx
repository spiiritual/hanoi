import { useEffect, useMemo, useRef, useState } from "react";
import type { ImgHTMLAttributes, ReactNode, SyntheticEvent } from "react";

import type { ArtworkVariant } from "../../bun/plex/artwork/types.ts";
import { plex } from "../plex.ts";
import {
  artworkAttemptKey,
  artworkRequestKey,
  artworkUrlForKey,
  normalizeArtworkSource,
  normalizeArtworkVariant,
  RendererArtworkStore,
  TRANSCODED_FALLBACK_VARIANT,
} from "./index.ts";
import type {
  ArtworkRequest,
  ArtworkRequestSource,
  ArtworkSource,
} from "./index.ts";

const requestArtwork: ArtworkRequest = async (source, variant) => {
  const request =
    source.kind === "server"
      ? plex.getArtwork(source.path, variant)
      : plex.getAccountArtwork(variant);
  const result = await request;
  return result;
};

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
  onError?: (event: SyntheticEvent<HTMLImageElement>) => void;
}

/**
 * Shared token-free Plex artwork image. The fallback span is also the
 * IntersectionObserver target, so a non-priority image cannot start its RPC
 * until it is near the viewport. `loading="lazy"` remains only a browser hint.
 */
interface ArtworkImageLoaderProps extends Omit<
  ArtworkImageProps,
  "source" | "variant"
> {
  normalizedSource: ArtworkSource | null;
  normalizedVariant: ArtworkVariant;
  requestKey: string;
}

const ArtworkImageLoader = ({
  normalizedSource,
  normalizedVariant,
  requestKey,
  priority = false,
  fallback,
  fallbackClassName,
  onError,
  alt,
  ...imageProps
}: ArtworkImageLoaderProps) => {
  const [isLoadStarted, setIsLoadStarted] = useState(priority);
  const [loadedImage, setLoadedImage] = useState<{
    key: string;
    url: string;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const targetRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    let observer: IntersectionObserver | null = null;
    if (normalizedSource === null || priority || requestKey.length === 0) {
      return () => {
        observer?.disconnect();
      };
    }
    const target = targetRef.current;
    if (!("IntersectionObserver" in globalThis) || target === null) {
      setIsLoadStarted(true);
      return () => {
        observer?.disconnect();
      };
    }
    observer = new IntersectionObserver(
      (entries) => {
        if (
          entries.some(
            (entry) => entry.isIntersecting || entry.intersectionRatio > 0
          )
        ) {
          setIsLoadStarted(true);
          observer?.disconnect();
        }
      },
      { rootMargin: "400px 0px" }
    );
    observer.observe(target);
    return () => {
      observer?.disconnect();
    };
  }, [normalizedSource, priority, requestKey]);

  useEffect(() => {
    let release: (() => void) | null = null;
    if (
      normalizedSource === null ||
      !isLoadStarted ||
      requestKey.length === 0
    ) {
      return () => {
        release?.();
      };
    }
    const activeVariant =
      attempt === 0 ? normalizedVariant : TRANSCODED_FALLBACK_VARIANT;
    const loadAttemptKey = artworkAttemptKey(
      normalizedSource,
      activeVariant,
      attempt
    );
    const acquired = rendererArtworkStore.acquire(
      normalizedSource,
      activeVariant
    );
    const { promise, release: acquiredRelease } = acquired;
    release = acquiredRelease;
    let active = true;
    const loadImage = async (): Promise<void> => {
      const url = await promise;
      if (active && url !== null) {
        setLoadedImage({ key: loadAttemptKey, url });
      }
    };
    void loadImage();
    return () => {
      active = false;
      release?.();
    };
  }, [attempt, isLoadStarted, normalizedSource, normalizedVariant, requestKey]);

  const handleError = (event: SyntheticEvent<HTMLImageElement>) => {
    if (attempt === 0 && normalizedSource !== null) {
      setLoadedImage(null);
      setAttempt(1);
      return;
    }
    setLoadedImage(null);
    onError?.(event);
  };

  const activeVariant =
    attempt === 0 ? normalizedVariant : TRANSCODED_FALLBACK_VARIANT;
  const activeImageKey =
    normalizedSource !== null && isLoadStarted
      ? artworkAttemptKey(normalizedSource, activeVariant, attempt)
      : "";
  const imageSrc = artworkUrlForKey(loadedImage, activeImageKey);

  return (
    <>
      <span
        ref={targetRef}
        className={fallbackClassName}
        hidden={Boolean(imageSrc)}
      >
        {fallback}
      </span>
      {imageSrc !== null && (
        <img
          {...imageProps}
          src={imageSrc}
          alt={alt}
          loading="lazy"
          onError={handleError}
        />
      )}
    </>
  );
};

export const ArtworkImage = ({
  source,
  variant,
  priority = false,
  fallback,
  fallbackClassName,
  onError,
  alt,
  ...imageProps
}: ArtworkImageProps) => {
  // Memoization keeps the normalized request identity stable for the load effects.
  // oxlint-disable-next-line react-doctor/react-compiler-no-manual-memoization -- effect dependencies require stable request identity
  const normalizedSource = useMemo(
    () => normalizeArtworkSource(source),
    [source]
  );
  // oxlint-disable-next-line react-doctor/react-compiler-no-manual-memoization -- avoid rebuilding the cache key on unrelated renders
  const normalizedVariant = useMemo(
    () => normalizeArtworkVariant(variant),
    [variant]
  );
  const requestKey = normalizedSource
    ? artworkRequestKey(normalizedSource, normalizedVariant)
    : "";
  const componentKey = `${requestKey}:${priority ? "priority" : "deferred"}`;

  return (
    <ArtworkImageLoader
      key={componentKey}
      {...imageProps}
      alt={alt}
      fallback={fallback}
      fallbackClassName={fallbackClassName}
      normalizedSource={normalizedSource}
      normalizedVariant={normalizedVariant}
      onError={onError}
      priority={priority}
      requestKey={requestKey}
    />
  );
};
