//! The memory + disk artwork cache: `../../src/bun/plex/artwork/cache.ts`.
//!
//! The reference keeps its metadata in SQLite; here each object carries a JSON
//! sidecar next to it (`<key>.bin` + `<key>.json`) and the LRU accounting is
//! rebuilt from a directory scan the first time the store is used. Everything
//! else — the freshness policy, the conditional revalidation, the eviction
//! order, the per-key dedupe and the namespace clear — follows the reference.
//!
//! Unlike the Electrobun app, the decoded frame is what callers want, so the
//! in-memory LRU holds a frame rather than raw bytes; the bytes live only on
//! disk.
//!
//! It holds that frame **weakly**. `RenderImage` has no `Drop`: its texture
//! lives in the window's sprite atlas until `Window::drop_image` is called, so
//! exactly one place may own a frame and decide when it dies — the shell's slot
//! map (`ui::home::state::ArtworkState`), bounded by `MAX_SLOTS` and
//! `MAX_SLOT_BYTES`. A second strong reference here would both double the
//! resident set and make `Arc::strong_count` useless as the "nobody is painting
//! this any more" test the release queue depends on. So this map is only a
//! short-cut past a decode for a frame someone else still holds; when the last
//! owner lets go, `peek` misses and the disk cache serves it again — a 23 KB
//! JPEG re-decodes in about a millisecond.

use std::collections::{HashMap, HashSet};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError, Weak};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context as _, Result, anyhow, bail};
use gpui::RenderImage;
use image::Frame;
use serde::{Deserialize, Serialize};

use super::fetcher::{
    Fetch, FetchOutcome, FetchRequest, HttpFetcher, is_image_content_type, validate_body,
};
use super::key::{
    Addressed, ArtworkKey, Credentials, Namespace, contains_token_material, has_control_characters,
};
use crate::plex::PLEX_TV_URL;

/// The limits from `HOME.md` (`DEFAULT_*` in `cache.ts`).
#[derive(Clone, Copy, Debug)]
pub(crate) struct Limits {
    /// How many weak frame references the memory map keeps. Not a memory
    /// budget — the frames themselves are owned by the shell's slot map, which
    /// is where the bytes are counted — just a bound on the map itself so a
    /// long session cannot grow it without limit.
    pub memory_max_entries: usize,
    pub max_entries: usize,
    pub max_bytes: u64,
    pub max_object_bytes: u64,
    pub fresh_ttl_ms: u64,
    pub stale_while_revalidate_ms: u64,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            memory_max_entries: 100,
            max_entries: 1000,
            max_bytes: 100 * 1024 * 1024,
            max_object_bytes: 25 * 1024 * 1024,
            fresh_ttl_ms: 7 * 24 * 60 * 60 * 1000,
            stale_while_revalidate_ms: 30 * 24 * 60 * 60 * 1000,
        }
    }
}

const OBJECTS_DIRECTORY: &str = "objects";

/// Re-writing a sidecar on every cache hit would turn scrolling the home
/// screen into a write storm, so the on-disk access time is only refreshed
/// once an hour. The in-memory LRU order is always exact.
const ACCESS_PERSIST_INTERVAL_MS: u64 = 60 * 60 * 1000;

/// Wall-clock milliseconds; injectable so the freshness tests are deterministic.
pub(crate) type Clock = Arc<dyn Fn() -> u64 + Send + Sync>;

/// Memory + disk artwork cache shared by every screen.
pub struct ArtworkStore {
    inner: Arc<Inner>,
}

impl ArtworkStore {
    /// Open (or create) the cache under `root`.
    pub fn new(root: PathBuf) -> Arc<Self> {
        let inner = Inner::new(
            root,
            Arc::new(HttpFetcher),
            Arc::new(system_clock),
            Limits::default(),
        );
        // Build the LRU accounting off the caller's thread: the first `load`
        // waits for it, `peek` never does.
        let scanner = Arc::clone(&inner);
        if let Err(error) = thread::Builder::new()
            .name("hanoi-artwork-scan".to_owned())
            .spawn(move || scanner.ensure_scanned())
        {
            log::warn!("could not start the artwork cache scan: {error}");
        }
        Arc::new(Self { inner })
    }

    /// `<cache dir>/hanoi-gpui/artwork`, overridable with `HANOI_ARTWORK_CACHE`.
    pub fn default_root() -> PathBuf {
        if let Some(path) = std::env::var_os("HANOI_ARTWORK_CACHE") {
            return PathBuf::from(path);
        }
        dirs::cache_dir()
            .unwrap_or_else(|| PathBuf::from("."))
            .join("hanoi-gpui")
            .join("artwork")
    }

    /// A decoded frame the memory LRU still has a live reference to, without
    /// touching disk or the network. Safe to call from the render pass.
    ///
    /// `None` once the frame's owner has released it, even if the key was
    /// remembered: the map holds weak references only (see the module header).
    pub fn peek(&self, key: &ArtworkKey) -> Option<Arc<RenderImage>> {
        self.inner.peek(key)
    }

    /// Memory -> disk -> network, decoding to the BGRA frame gpui renders.
    /// **Blocking**; returns `None` when the object cannot be fetched or decoded.
    pub fn load(&self, key: &ArtworkKey, credentials: &Credentials) -> Option<Arc<RenderImage>> {
        self.inner.load(key, credentials)
    }

    /// Drop every object of one namespace (sign-out, server switch).
    pub fn clear_namespace(&self, namespace: &Namespace) {
        self.inner.clear_namespace(namespace);
    }

    /// A store with an injected fetcher, clock and limits: the tests' seam,
    /// and the reason nothing here needs a gpui `App`.
    #[cfg(test)]
    fn with_parts(root: PathBuf, fetcher: Arc<dyn Fetch>, clock: Clock, limits: Limits) -> Self {
        Self {
            inner: Inner::new(root, fetcher, clock, limits),
        }
    }
}

/// What the sidecar records about one object. The field names are the
/// on-disk contract; nothing secret may appear in any of them.
#[derive(Clone, Debug, Deserialize, Serialize)]
struct Sidecar {
    namespace: Namespace,
    /// The canonical, token-free source.
    source: String,
    /// The canonical variant (`serializeVariant`).
    variant: String,
    byte_size: u64,
    content_type: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    etag: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    last_modified: Option<String>,
    fetched_at: u64,
    validated_at: u64,
    last_accessed_at: u64,
}

/// The in-memory half of a sidecar (the bytes stay on disk).
#[derive(Clone, Debug)]
struct Entry {
    namespace: Namespace,
    byte_size: u64,
    etag: Option<String>,
    last_modified: Option<String>,
    content_type: String,
    source: String,
    variant: String,
    fetched_at: u64,
    validated_at: u64,
    last_accessed_at: u64,
    /// Tie-breaker for two objects touched in the same millisecond.
    access_sequence: u64,
}

impl Entry {
    fn from_sidecar(sidecar: Sidecar, access_sequence: u64) -> Self {
        Self {
            namespace: sidecar.namespace,
            byte_size: sidecar.byte_size,
            etag: sidecar.etag,
            last_modified: sidecar.last_modified,
            content_type: sidecar.content_type,
            source: sidecar.source,
            variant: sidecar.variant,
            fetched_at: sidecar.fetched_at,
            validated_at: sidecar.validated_at,
            last_accessed_at: sidecar.last_accessed_at,
            access_sequence,
        }
    }

    fn to_sidecar(&self) -> Sidecar {
        Sidecar {
            namespace: self.namespace.clone(),
            source: self.source.clone(),
            variant: self.variant.clone(),
            byte_size: self.byte_size,
            content_type: self.content_type.clone(),
            etag: self.etag.clone(),
            last_modified: self.last_modified.clone(),
            fetched_at: self.fetched_at,
            validated_at: self.validated_at,
            last_accessed_at: self.last_accessed_at,
        }
    }
}

/// The LRU accounting for the disk cache.
#[derive(Default)]
struct Index {
    entries: HashMap<String, Entry>,
    total_bytes: u64,
    sequence: u64,
    /// `NamespaceLifecycle.generation`: bumped by every `clear_namespace`, so
    /// a fetch that started before the clear cannot write its object back.
    epochs: HashMap<Namespace, u64>,
}

impl Index {
    fn next_sequence(&mut self) -> u64 {
        self.sequence += 1;
        self.sequence
    }

    fn epoch(&self, namespace: &Namespace) -> u64 {
        self.epochs.get(namespace).copied().unwrap_or_default()
    }

    /// Insert (or replace) an entry, keeping `total_bytes` in step.
    fn insert_entry(&mut self, digest: String, entry: Entry) {
        let bytes = entry.byte_size;
        if let Some(previous) = self.entries.insert(digest, entry) {
            self.total_bytes = self.total_bytes.saturating_sub(previous.byte_size);
        }
        self.total_bytes = self.total_bytes.saturating_add(bytes);
    }

    fn remove(&mut self, digest: &str) -> Option<Entry> {
        let removed = self.entries.remove(digest)?;
        self.total_bytes = self.total_bytes.saturating_sub(removed.byte_size);
        Some(removed)
    }

    /// `ORDER BY access_sequence ASC, fetched_at ASC, key ASC`, expressed
    /// against the access time the sidecars persist.
    fn least_recently_accessed(&self) -> Option<String> {
        self.entries
            .iter()
            .min_by(|(left_key, left), (right_key, right)| {
                left.last_accessed_at
                    .cmp(&right.last_accessed_at)
                    .then(left.access_sequence.cmp(&right.access_sequence))
                    .then(left.fetched_at.cmp(&right.fetched_at))
                    .then(left_key.cmp(right_key))
            })
            .map(|(digest, _)| digest.clone())
    }
}

/// A borrowed view of one decoded frame plus its recency. `image` is weak on
/// purpose: see the module header. An entry whose frame has been released is
/// indistinguishable from a miss, and is dropped the moment it is noticed.
struct MemoryEntry {
    image: Weak<RenderImage>,
    sequence: u64,
}

#[derive(Default)]
struct Memory {
    entries: HashMap<ArtworkKey, MemoryEntry>,
    sequence: u64,
}

struct Inner {
    objects: PathBuf,
    limits: Limits,
    clock: Clock,
    fetcher: Arc<dyn Fetch>,
    index: Mutex<Index>,
    /// Guards the one-time directory scan; held only while it runs.
    scanned: Mutex<bool>,
    /// Weak references to the decoded frames their owners still hold. No I/O
    /// ever happens while this is held, which is what keeps `peek` cheap
    /// enough for a render pass.
    memory: Mutex<Memory>,
    /// `inFlight`: one lock per object so concurrent loads collapse onto one fetch.
    locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    /// Keys with a background stale-while-revalidate refresh already running.
    refreshing: Mutex<Vec<String>>,
}

impl Inner {
    fn new(root: PathBuf, fetcher: Arc<dyn Fetch>, clock: Clock, limits: Limits) -> Arc<Self> {
        Arc::new(Self {
            objects: root.join(OBJECTS_DIRECTORY),
            limits,
            clock,
            fetcher,
            index: Mutex::default(),
            scanned: Mutex::new(false),
            memory: Mutex::default(),
            locks: Mutex::default(),
            refreshing: Mutex::default(),
        })
    }

    fn peek(&self, key: &ArtworkKey) -> Option<Arc<RenderImage>> {
        let mut memory = lock(&self.memory);
        let sequence = memory.sequence + 1;
        memory.sequence = sequence;
        let entry = memory.entries.get_mut(key)?;
        let Some(image) = entry.image.upgrade() else {
            // The last owner released the frame (and its atlas texture with
            // it); the entry is a tombstone, so drop it and report a miss.
            memory.entries.remove(key);
            return None;
        };
        entry.sequence = sequence;
        Some(image)
    }

    fn load(
        self: &Arc<Self>,
        key: &ArtworkKey,
        credentials: &Credentials,
    ) -> Option<Arc<RenderImage>> {
        if let Some(image) = self.peek(key) {
            return Some(image);
        }
        let Some(addressed) = Addressed::new(key) else {
            // A source carrying token material, or no source at all: never
            // fetched, never cached, never logged in full.
            log::warn!("refusing to load artwork from an unusable source");
            return None;
        };

        let object_lock = self.object_lock(&addressed.digest);
        let _guard = lock(&object_lock);
        // The loser of the race re-checks memory before touching the disk.
        if let Some(image) = self.peek(key) {
            return Some(image);
        }

        let data = self.bytes_for(&addressed, credentials)?;
        let image = decode(&data)?;
        self.remember(key.clone(), &image);
        Some(image)
    }

    /// `getOrFetch`: memory -> disk -> conditional network, with the
    /// fresh / stale-while-revalidate / expired policy.
    fn bytes_for(
        self: &Arc<Self>,
        addressed: &Addressed,
        credentials: &Credentials,
    ) -> Option<Vec<u8>> {
        self.ensure_scanned();
        let epoch = lock(&self.index).epoch(&addressed.namespace);
        let Some((entry, data)) = self.read_stored(addressed) else {
            return match self.revalidate(addressed, credentials, None, epoch) {
                Ok(Some(data)) => Some(data),
                Ok(None) => None,
                Err(error) => {
                    log::warn!("failed to fetch artwork: {error}");
                    None
                }
            };
        };

        self.touch(&addressed.digest);
        let age = self.now().saturating_sub(entry.validated_at);
        if age <= self.limits.fresh_ttl_ms {
            return Some(data);
        }
        if age <= self.limits.fresh_ttl_ms + self.limits.stale_while_revalidate_ms {
            self.spawn_refresh(addressed, credentials);
            return Some(data);
        }
        // Past the stale window the refresh is awaited, but a failed refresh
        // still serves the object we have.
        match self.revalidate(addressed, credentials, Some(&entry), epoch) {
            Ok(Some(fresh)) => Some(fresh),
            Ok(None) => Some(data),
            Err(error) => {
                log::warn!("failed to revalidate artwork, serving the stale object: {error}");
                Some(data)
            }
        }
    }

    /// One conditional request: `Ok(Some(bytes))` for a 200, `Ok(None)` for a
    /// 304 that kept the cached object.
    fn revalidate(
        &self,
        addressed: &Addressed,
        credentials: &Credentials,
        existing: Option<&Entry>,
        epoch: u64,
    ) -> Result<Option<Vec<u8>>> {
        let base_url = if addressed.account {
            PLEX_TV_URL
        } else {
            credentials.base_url.as_str()
        };
        let outcome = self.fetcher.fetch(FetchRequest {
            base_url,
            token: &credentials.token,
            source: &addressed.source,
            variant: addressed.variant,
            etag: existing.and_then(|entry| entry.etag.as_deref()),
            last_modified: existing.and_then(|entry| entry.last_modified.as_deref()),
            max_object_bytes: self.limits.max_object_bytes,
        })?;

        match outcome {
            FetchOutcome::NotModified {
                etag,
                last_modified,
            } => {
                let Some(existing) = existing else {
                    bail!("Artwork fetch returned 304 without a cached object");
                };
                self.refresh_not_modified(addressed, existing, etag, last_modified, epoch);
                Ok(None)
            }
            FetchOutcome::Body {
                data,
                content_type,
                etag,
                last_modified,
            } => {
                self.store(addressed, &data, &content_type, etag, last_modified, epoch)?;
                Ok(Some(data))
            }
        }
    }

    /// `refreshNotModified`: the object stays, its validity window restarts.
    fn refresh_not_modified(
        &self,
        addressed: &Addressed,
        existing: &Entry,
        etag: Option<String>,
        last_modified: Option<String>,
        epoch: u64,
    ) {
        let now = self.now();
        let mut refreshed = existing.clone();
        refreshed.validated_at = now;
        refreshed.last_accessed_at = now;
        refreshed.etag = etag.or_else(|| existing.etag.clone());
        refreshed.last_modified = last_modified.or_else(|| existing.last_modified.clone());
        if lock(&self.index).epoch(&addressed.namespace) != epoch {
            return;
        }
        if let Err(error) = self.write_sidecar(&addressed.digest, &refreshed.to_sidecar()) {
            log::warn!("failed to record an artwork revalidation: {error}");
            return;
        }
        let mut index = lock(&self.index);
        // A clear that landed while the sidecar was being written must not be
        // undone by it.
        if index.epoch(&addressed.namespace) != epoch {
            drop(index);
            self.remove_files(&addressed.digest);
            return;
        }
        refreshed.access_sequence = index.next_sequence();
        index.insert_entry(addressed.digest.clone(), refreshed);
    }

    /// `persistResponse`: validate, write both files atomically, then evict.
    fn store(
        &self,
        addressed: &Addressed,
        data: &[u8],
        content_type: &str,
        etag: Option<String>,
        last_modified: Option<String>,
        epoch: u64,
    ) -> Result<()> {
        // An injected fetcher could skip the network's own checks, so the
        // cache validates everything it is about to write.
        let content_type = validate_body(data, content_type, self.limits.max_object_bytes)?;
        let now = self.now();
        let sidecar = Sidecar {
            namespace: addressed.namespace.clone(),
            source: addressed.source.clone(),
            variant: addressed.variant.canonical(),
            byte_size: data.len() as u64,
            content_type,
            etag,
            last_modified,
            fetched_at: now,
            validated_at: now,
            last_accessed_at: now,
        };
        if !is_sidecar_safe(&sidecar, &addressed.digest) {
            bail!("Artwork metadata contains unsafe token material");
        }

        self.write_object(&addressed.digest, data)?;
        if let Err(error) = self.write_sidecar(&addressed.digest, &sidecar) {
            // Never leave an object without its sidecar behind.
            remove_if_present(&self.object_path(&addressed.digest));
            return Err(error);
        }

        {
            let mut index = lock(&self.index);
            // The epoch is checked while the index is held, so an object can
            // never be written back after the clear that removed it.
            if index.epoch(&addressed.namespace) != epoch {
                drop(index);
                self.remove_files(&addressed.digest);
                bail!("Artwork fetch was invalidated by a namespace clear");
            }
            let sequence = index.next_sequence();
            index.insert_entry(
                addressed.digest.clone(),
                Entry::from_sidecar(sidecar, sequence),
            );
        }
        self.evict_if_needed();
        Ok(())
    }

    /// Read an object and its metadata, dropping the pair when they disagree.
    fn read_stored(&self, addressed: &Addressed) -> Option<(Entry, Vec<u8>)> {
        let entry = lock(&self.index).entries.get(&addressed.digest).cloned()?;
        match fs::read(self.object_path(&addressed.digest)) {
            Ok(data) if !data.is_empty() && data.len() as u64 == entry.byte_size => {
                Some((entry, data))
            }
            Ok(_) => {
                log::warn!("artwork object does not match its sidecar; dropping it");
                self.forget(&addressed.digest);
                None
            }
            Err(error) => {
                if error.kind() != io::ErrorKind::NotFound {
                    log::warn!("failed to read a cached artwork object: {error}");
                }
                self.forget(&addressed.digest);
                None
            }
        }
    }

    /// `touchAndReturn`: the object just became the most recently used one.
    fn touch(&self, digest: &str) {
        let now = self.now();
        let mut index = lock(&self.index);
        let sequence = index.next_sequence();
        let Some(entry) = index.entries.get_mut(digest) else {
            return;
        };
        let persist = now.saturating_sub(entry.last_accessed_at) >= ACCESS_PERSIST_INTERVAL_MS;
        entry.last_accessed_at = now;
        entry.access_sequence = sequence;
        let sidecar = persist.then(|| entry.to_sidecar());
        drop(index);

        if let Some(sidecar) = sidecar
            && let Err(error) = self.write_sidecar(digest, &sidecar)
        {
            log::warn!("failed to record an artwork access: {error}");
        }
    }

    /// Stale-while-revalidate: refresh on a plain thread so the store stays
    /// usable without a gpui executor. One refresh per key at a time.
    fn spawn_refresh(self: &Arc<Self>, addressed: &Addressed, credentials: &Credentials) {
        {
            let mut refreshing = lock(&self.refreshing);
            if refreshing.iter().any(|digest| digest == &addressed.digest) {
                return;
            }
            refreshing.push(addressed.digest.clone());
        }

        let store = Arc::clone(self);
        let digest = addressed.digest.clone();
        let addressed = addressed.clone();
        let credentials = credentials.clone();
        let spawned = thread::Builder::new()
            .name("hanoi-artwork-refresh".to_owned())
            .spawn(move || {
                // The caller still holds this object's lock; waiting for it
                // keeps the refresh from racing the read that triggered it.
                let object_lock = store.object_lock(&addressed.digest);
                {
                    let _guard = lock(&object_lock);
                    let (existing, epoch) = {
                        let index = lock(&store.index);
                        (
                            index.entries.get(&addressed.digest).cloned(),
                            index.epoch(&addressed.namespace),
                        )
                    };
                    if let Err(error) =
                        store.revalidate(&addressed, &credentials, existing.as_ref(), epoch)
                    {
                        log::warn!("background artwork refresh failed: {error}");
                    }
                }
                lock(&store.refreshing).retain(|digest| digest != &addressed.digest);
            });
        if let Err(error) = spawned {
            log::warn!("could not start a background artwork refresh: {error}");
            lock(&self.refreshing).retain(|queued| queued != &digest);
        }
    }

    /// `clearNamespace`: every object of one account/server pair, in memory
    /// and on disk.
    ///
    /// Forgetting the weak entries frees nothing on its own — a frame lives as
    /// long as its owner does, and `ArtworkState::clear` is what releases the
    /// namespace's frames and queues their textures for `Window::drop_image`.
    fn clear_namespace(&self, namespace: &Namespace) {
        self.ensure_scanned();
        let victims: Vec<String> = {
            let mut index = lock(&self.index);
            *index.epochs.entry(namespace.clone()).or_default() += 1;
            let victims: Vec<String> = index
                .entries
                .iter()
                .filter(|(_, entry)| &entry.namespace == namespace)
                .map(|(digest, _)| digest.clone())
                .collect();
            for digest in &victims {
                index.remove(digest);
            }
            victims
        };
        for digest in &victims {
            self.remove_files(digest);
        }
        lock(&self.memory)
            .entries
            .retain(|key, entry| &key.namespace != namespace && entry.image.strong_count() > 0);
    }

    /// Build the LRU accounting from the objects directory, deleting anything
    /// unusable: a temporary file, an object without a sidecar (or the other
    /// way round) and metadata that fails its safety checks.
    fn ensure_scanned(&self) {
        let mut scanned = lock(&self.scanned);
        if *scanned {
            return;
        }
        self.scan();
        *scanned = true;
    }

    fn scan(&self) {
        if let Err(error) = fs::create_dir_all(&self.objects) {
            log::warn!(
                "could not create the artwork cache at {}: {error}",
                self.objects.display()
            );
            return;
        }
        let entries = match fs::read_dir(&self.objects) {
            Ok(entries) => entries,
            Err(error) => {
                log::warn!("could not read the artwork cache: {error}");
                return;
            }
        };

        let mut objects: HashSet<String> = HashSet::new();
        let mut sidecars: Vec<String> = Vec::new();
        for entry in entries.flatten() {
            if !entry.file_type().is_ok_and(|kind| kind.is_file()) {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            if let Some(digest) = name.strip_suffix(".bin") {
                objects.insert(digest.to_owned());
            } else if let Some(digest) = name.strip_suffix(".json") {
                sidecars.push(digest.to_owned());
            } else {
                // A `.tmp` left behind by an interrupted write, or a stray file.
                remove_if_present(&self.objects.join(&name));
            }
        }

        let mut index = lock(&self.index);
        for digest in &sidecars {
            if !objects.contains(digest.as_str()) {
                remove_if_present(&self.sidecar_path(digest));
                continue;
            }
            match self.read_sidecar(digest) {
                Some(sidecar) => {
                    index.insert_entry(digest.clone(), Entry::from_sidecar(sidecar, 0));
                }
                None => {
                    self.remove_files(digest);
                }
            }
        }
        for digest in &objects {
            if !index.entries.contains_key(digest) {
                remove_if_present(&self.object_path(digest));
            }
        }
        drop(index);
        // The limits may have shrunk, or a crash may have left the cache over
        // budget; either way it is brought back inside it now.
        self.evict_if_needed();
    }

    fn read_sidecar(&self, digest: &str) -> Option<Sidecar> {
        let raw = fs::read_to_string(self.sidecar_path(digest)).ok()?;
        let sidecar: Sidecar = serde_json::from_str(&raw).ok()?;
        if !is_sidecar_safe(&sidecar, digest) {
            log::warn!("dropping an artwork object whose metadata failed validation");
            return None;
        }
        let size = fs::metadata(self.object_path(digest)).ok()?.len();
        if size != sidecar.byte_size || size == 0 || size > self.limits.max_object_bytes {
            return None;
        }
        Some(sidecar)
    }

    /// Least-recently-accessed first, until both budgets fit.
    fn evict_if_needed(&self) {
        let mut victims: Vec<String> = Vec::new();
        {
            let mut index = lock(&self.index);
            while index.entries.len() > self.limits.max_entries
                || index.total_bytes > self.limits.max_bytes
            {
                let Some(digest) = index.least_recently_accessed() else {
                    break;
                };
                index.remove(&digest);
                victims.push(digest);
            }
        }
        for digest in &victims {
            self.remove_files(digest);
        }
    }

    /// Drop one object from the index and the disk.
    fn forget(&self, digest: &str) {
        lock(&self.index).remove(digest);
        self.remove_files(digest);
    }

    fn remove_files(&self, digest: &str) {
        remove_if_present(&self.object_path(digest));
        remove_if_present(&self.sidecar_path(digest));
    }

    fn write_object(&self, digest: &str, data: &[u8]) -> Result<()> {
        self.write_atomically(&self.object_path(digest), data)
    }

    fn write_sidecar(&self, digest: &str, sidecar: &Sidecar) -> Result<()> {
        let json = serde_json::to_vec(sidecar).context("failed to serialize artwork metadata")?;
        self.write_atomically(&self.sidecar_path(digest), &json)
    }

    /// Temp file + rename, so a reader never sees a half-written object.
    fn write_atomically(&self, path: &Path, bytes: &[u8]) -> Result<()> {
        fs::create_dir_all(&self.objects)
            .with_context(|| format!("failed to create {}", self.objects.display()))?;
        let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
        fs::write(&temporary, bytes)
            .with_context(|| format!("failed to write {}", temporary.display()))?;
        if let Err(error) = fs::rename(&temporary, path) {
            remove_if_present(&temporary);
            return Err(anyhow!("failed to replace {}: {error}", path.display()));
        }
        Ok(())
    }

    fn object_path(&self, digest: &str) -> PathBuf {
        self.objects.join(format!("{digest}.bin"))
    }

    fn sidecar_path(&self, digest: &str) -> PathBuf {
        self.objects.join(format!("{digest}.json"))
    }

    fn object_lock(&self, digest: &str) -> Arc<Mutex<()>> {
        let mut locks = lock(&self.locks);
        // Locks outlive their load so a second caller finds the same one;
        // the ones nobody holds any more are pruned when the map gets big.
        if locks.len() > 4096 {
            locks.retain(|_, object_lock| Arc::strong_count(object_lock) > 1);
        }
        Arc::clone(locks.entry(digest.to_owned()).or_default())
    }

    /// Record a weak reference to a frame someone else now owns.
    ///
    /// Nothing is freed by evicting here — the frame's bytes belong to its
    /// owner — so the only thing to bound is the map itself. Tombstones are
    /// cleared first, which on a screen that has just been released is usually
    /// the whole of the work.
    fn remember(&self, key: ArtworkKey, image: &Arc<RenderImage>) {
        let mut memory = lock(&self.memory);
        let sequence = memory.sequence + 1;
        memory.sequence = sequence;
        memory.entries.insert(
            key,
            MemoryEntry {
                image: Arc::downgrade(image),
                sequence,
            },
        );

        if memory.entries.len() > self.limits.memory_max_entries {
            memory
                .entries
                .retain(|_, entry| entry.image.strong_count() > 0);
        }
        while memory.entries.len() > self.limits.memory_max_entries {
            let Some(oldest) = memory
                .entries
                .iter()
                .min_by_key(|(_, entry)| entry.sequence)
                .map(|(key, _)| key.clone())
            else {
                break;
            };
            memory.entries.remove(&oldest);
        }
    }

    fn now(&self) -> u64 {
        (self.clock)()
    }
}

/// `assertStoredRowSafe`: metadata that could carry a token, or that no longer
/// describes an image, is not allowed back into the cache.
fn is_sidecar_safe(sidecar: &Sidecar, digest: &str) -> bool {
    if digest.len() != 64 || !digest.chars().all(|c| c.is_ascii_hexdigit()) {
        return false;
    }
    let fields = [
        sidecar.namespace.account_id.as_str(),
        sidecar.namespace.server_id.as_str(),
        sidecar.source.as_str(),
        sidecar.variant.as_str(),
        sidecar.content_type.as_str(),
        sidecar.etag.as_deref().unwrap_or_default(),
        sidecar.last_modified.as_deref().unwrap_or_default(),
    ];
    if fields
        .iter()
        .any(|field| has_control_characters(field) || contains_token_material(field))
    {
        return false;
    }
    is_image_content_type(&sidecar.content_type)
}

/// Decode into the BGRA frame gpui's renderer expects — the same conversion
/// `decode_avatar` performs in `src/ui/auth/mod.rs`.
fn decode(bytes: &[u8]) -> Option<Arc<RenderImage>> {
    let mut rgba = image::load_from_memory(bytes)
        .inspect_err(|error| log::warn!("failed to decode artwork: {error}"))
        .ok()?
        .into_rgba8();
    for pixel in rgba.chunks_exact_mut(4) {
        pixel.swap(0, 2);
    }
    Some(Arc::new(RenderImage::new(vec![Frame::new(rgba)])))
}

fn remove_if_present(path: &Path) {
    match fs::remove_file(path) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => log::warn!("failed to remove {}: {error}", path.display()),
    }
}

/// A poisoned cache lock only means some other thread panicked mid-update; the
/// cache is rebuildable, so carrying on is better than taking the app down.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

fn system_clock() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| elapsed.as_millis() as u64)
}

#[cfg(test)]
mod tests {
    use std::collections::VecDeque;
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
    use std::sync::mpsc;

    use anyhow::{Result, anyhow};

    use super::super::fetcher::{Fetch, FetchOutcome, FetchRequest};
    use super::super::key::{Addressed, ArtworkKey, Credentials, Namespace, Source, Variant};
    use super::{ArtworkStore, Clock, Limits, Sidecar, lock};

    const DAY_MS: u64 = 24 * 60 * 60 * 1000;

    /// A unique directory under the system temp dir, removed with the test.
    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new(label: &str) -> Self {
            static COUNTER: AtomicU32 = AtomicU32::new(0);
            let unique = COUNTER.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "hanoi-artwork-tests-{}-{label}-{unique}",
                std::process::id()
            ));
            std::fs::create_dir_all(&path).expect("temp dir");
            Self(path)
        }

        fn path(&self) -> PathBuf {
            self.0.clone()
        }

        fn objects(&self) -> PathBuf {
            self.0.join("objects")
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// One stubbed network answer.
    #[derive(Clone, Debug)]
    enum Stub {
        Image {
            data: Vec<u8>,
            content_type: String,
            etag: Option<String>,
        },
        NotModified,
        Failure(String),
    }

    impl Stub {
        fn png(etag: Option<&str>) -> Self {
            Self::Image {
                data: png_bytes(4, 4),
                content_type: "image/png".to_owned(),
                etag: etag.map(str::to_owned),
            }
        }
    }

    /// What the cache asked the network for.
    #[derive(Clone, Debug, PartialEq, Eq)]
    struct StubCall {
        base_url: String,
        token: String,
        source: String,
        variant: Variant,
        etag: Option<String>,
        last_modified: Option<String>,
    }

    /// The injected fetcher: the last stub repeats, so a test only queues the
    /// answers it cares about.
    #[derive(Default)]
    struct StubFetcher {
        outcomes: Mutex<VecDeque<Stub>>,
        calls: Mutex<Vec<StubCall>>,
        /// Optional handshake: announce that a fetch started, then wait to be
        /// released, so a test can interleave something with it.
        gate: Mutex<Option<(mpsc::Sender<()>, mpsc::Receiver<()>)>>,
    }

    impl StubFetcher {
        fn new(outcomes: impl IntoIterator<Item = Stub>) -> Arc<Self> {
            Arc::new(Self {
                outcomes: Mutex::new(outcomes.into_iter().collect()),
                calls: Mutex::default(),
                gate: Mutex::default(),
            })
        }

        fn calls(&self) -> Vec<StubCall> {
            lock(&self.calls).clone()
        }

        fn call_count(&self) -> usize {
            lock(&self.calls).len()
        }
    }

    impl Fetch for StubFetcher {
        fn fetch(&self, request: FetchRequest<'_>) -> Result<FetchOutcome> {
            if let Some((started, release)) = lock(&self.gate).as_ref() {
                started.send(()).expect("announce the fetch");
                release.recv().expect("wait for the test");
            }
            lock(&self.calls).push(StubCall {
                base_url: request.base_url.to_owned(),
                token: request.token.to_owned(),
                source: request.source.to_owned(),
                variant: request.variant,
                etag: request.etag.map(str::to_owned),
                last_modified: request.last_modified.map(str::to_owned),
            });
            let mut outcomes = lock(&self.outcomes);
            let stub = if outcomes.len() > 1 {
                outcomes.pop_front()
            } else {
                outcomes.front().cloned()
            };
            match stub {
                Some(Stub::Image {
                    data,
                    content_type,
                    etag,
                }) => Ok(FetchOutcome::Body {
                    data,
                    content_type,
                    etag,
                    last_modified: None,
                }),
                Some(Stub::NotModified) => Ok(FetchOutcome::NotModified {
                    etag: None,
                    last_modified: None,
                }),
                Some(Stub::Failure(message)) => Err(anyhow!("{message}")),
                None => Err(anyhow!("no stubbed artwork response")),
            }
        }
    }

    fn png_bytes(width: u32, height: u32) -> Vec<u8> {
        let mut buffer = std::io::Cursor::new(Vec::new());
        image::RgbaImage::from_pixel(width, height, image::Rgba([10, 20, 30, 255]))
            .write_to(&mut buffer, image::ImageFormat::Png)
            .expect("encode a test png");
        buffer.into_inner()
    }

    fn namespace() -> Namespace {
        Namespace {
            account_id: "alexr".to_owned(),
            server_id: "home-id".to_owned(),
        }
    }

    fn key(source: &str) -> ArtworkKey {
        ArtworkKey {
            namespace: namespace(),
            source: Source::Server(source.to_owned()),
            variant: Variant::Native,
        }
    }

    fn credentials() -> Credentials {
        Credentials {
            base_url: "http://192.168.1.10:32400".to_owned(),
            token: "super-secret-token".to_owned(),
        }
    }

    /// A clock the test moves by hand.
    fn test_clock(start: u64) -> (Clock, Arc<AtomicU64>) {
        let now = Arc::new(AtomicU64::new(start));
        let handle = Arc::clone(&now);
        (Arc::new(move || handle.load(Ordering::SeqCst)), now)
    }

    fn store(
        root: &TempRoot,
        fetcher: Arc<StubFetcher>,
        clock: Clock,
        limits: Limits,
    ) -> ArtworkStore {
        ArtworkStore::with_parts(root.path(), fetcher, clock, limits)
    }

    fn digest_of(key: &ArtworkKey) -> String {
        Addressed::new(key).expect("addressable key").digest
    }

    fn sidecar_of(root: &TempRoot, key: &ArtworkKey) -> Sidecar {
        let path = root.objects().join(format!("{}.json", digest_of(key)));
        let raw = std::fs::read_to_string(path).expect("sidecar");
        serde_json::from_str(&raw).expect("sidecar json")
    }

    #[test]
    fn a_cold_load_fetches_decodes_and_writes_both_files() {
        let root = TempRoot::new("cold");
        let fetcher = StubFetcher::new([Stub::png(Some("\"v1\""))]);
        let (clock, now) = test_clock(1_000);
        let store = store(&root, Arc::clone(&fetcher), clock, Limits::default());

        let key = key("/library/metadata/1/thumb/2");
        assert!(store.peek(&key).is_none(), "nothing is in memory yet");
        let image = store.load(&key, &credentials()).expect("artwork");
        assert!(
            store.peek(&key).is_some(),
            "the decoded frame is now in memory"
        );
        assert_eq!(image.size(0).width.0, 4, "the frame is the decoded png");

        let digest = digest_of(&key);
        assert!(root.objects().join(format!("{digest}.bin")).exists());
        let sidecar = sidecar_of(&root, &key);
        assert_eq!(sidecar.namespace, namespace());
        assert_eq!(sidecar.source, "/library/metadata/1/thumb/2");
        assert_eq!(sidecar.variant, "[]");
        assert_eq!(sidecar.content_type, "image/png");
        assert_eq!(sidecar.etag.as_deref(), Some("\"v1\""));
        assert_eq!(sidecar.fetched_at, now.load(Ordering::SeqCst));
        assert_eq!(sidecar.validated_at, sidecar.fetched_at);

        let call = &fetcher.calls()[0];
        assert_eq!(call.base_url, "http://192.168.1.10:32400");
        assert_eq!(call.token, "super-secret-token");
        assert_eq!(call.etag, None, "a first fetch is unconditional");
    }

    #[test]
    fn no_token_ever_reaches_the_disk() {
        let root = TempRoot::new("token-free");
        let (clock, _) = test_clock(1_000);
        let store = store(
            &root,
            StubFetcher::new([Stub::png(None)]),
            clock,
            Limits::default(),
        );
        store
            .load(&key("/library/metadata/1/thumb/2"), &credentials())
            .expect("artwork");

        for entry in std::fs::read_dir(root.objects())
            .expect("objects")
            .flatten()
        {
            let name = entry.file_name().to_string_lossy().into_owned();
            assert!(!name.contains("token"), "{name} names a secret");
            let bytes = std::fs::read(entry.path()).expect("file");
            let text = String::from_utf8_lossy(&bytes).to_ascii_lowercase();
            assert!(
                !text.contains("super-secret-token"),
                "{name} stores the token"
            );
            assert!(!text.contains("plex-token"), "{name} stores token material");
        }
    }

    #[test]
    fn a_token_bearing_source_is_never_fetched() {
        let root = TempRoot::new("rejected");
        let fetcher = StubFetcher::new([Stub::png(None)]);
        let (clock, _) = test_clock(1_000);
        let store = store(&root, Arc::clone(&fetcher), clock, Limits::default());

        assert!(
            store
                .load(&key("/thumb/1?X-Plex-Token=secret"), &credentials())
                .is_none()
        );
        assert!(store.load(&key("   "), &credentials()).is_none());
        assert_eq!(
            fetcher.call_count(),
            0,
            "a rejected source never hits the network"
        );
    }

    #[test]
    fn a_second_load_is_served_from_memory_while_the_frame_is_still_owned() {
        let root = TempRoot::new("memory");
        let fetcher = StubFetcher::new([Stub::png(None)]);
        let (clock, _) = test_clock(1_000);
        let store = store(&root, Arc::clone(&fetcher), clock, Limits::default());

        let key = key("/thumb/1");
        let owned = store.load(&key, &credentials()).expect("artwork");
        let again = store.load(&key, &credentials()).expect("artwork");
        assert!(
            Arc::ptr_eq(&owned, &again),
            "the second load hands back the frame the first one decoded"
        );
        assert_eq!(fetcher.call_count(), 1);
    }

    #[test]
    fn a_released_frame_falls_out_of_memory_and_is_re_decoded_from_disk() {
        let root = TempRoot::new("weak");
        let fetcher = StubFetcher::new([Stub::png(None)]);
        let (clock, _) = test_clock(1_000);
        let store = store(&root, Arc::clone(&fetcher), clock, Limits::default());

        let key = key("/thumb/1");
        let owned = store.load(&key, &credentials()).expect("artwork");
        drop(owned);

        assert!(
            store.peek(&key).is_none(),
            "the store never keeps a frame alive by itself"
        );
        let reloaded = store.load(&key, &credentials()).expect("artwork");
        assert!(store.peek(&key).is_some(), "and remembers the new one");
        assert_eq!(
            fetcher.call_count(),
            1,
            "the disk cache is the second tier, not the network"
        );
        drop(reloaded);
    }

    #[test]
    fn a_restarted_store_reads_the_object_back_from_disk() {
        let root = TempRoot::new("round-trip");
        let (clock, now) = test_clock(1_000);
        let written = store(
            &root,
            StubFetcher::new([Stub::png(Some("\"v1\""))]),
            Arc::clone(&clock),
            Limits::default(),
        );
        let key = key("/thumb/1");
        assert!(written.load(&key, &credentials()).is_some());
        drop(written);

        // A day later, still inside the freshness window: no network at all.
        now.store(1_000 + DAY_MS, Ordering::SeqCst);
        let fetcher = StubFetcher::new([Stub::Failure("the network must not be used".to_owned())]);
        let reopened = store(&root, Arc::clone(&fetcher), clock, Limits::default());
        assert!(reopened.load(&key, &credentials()).is_some());
        assert_eq!(fetcher.call_count(), 0);
    }

    #[test]
    fn an_expired_object_is_revalidated_inline_and_304_keeps_it() {
        let root = TempRoot::new("not-modified");
        let (clock, now) = test_clock(1_000);
        let seed = store(
            &root,
            StubFetcher::new([Stub::png(Some("\"v1\""))]),
            Arc::clone(&clock),
            Limits::default(),
        );
        let key = key("/thumb/1");
        assert!(seed.load(&key, &credentials()).is_some());
        let object =
            std::fs::read(root.objects().join(format!("{}.bin", digest_of(&key)))).expect("object");
        drop(seed);

        // Past the 7 day + 30 day window, so the refresh is awaited.
        let expired_at = 1_000 + 40 * DAY_MS;
        now.store(expired_at, Ordering::SeqCst);
        let fetcher = StubFetcher::new([Stub::NotModified]);
        let reopened = store(&root, Arc::clone(&fetcher), clock, Limits::default());
        assert!(reopened.load(&key, &credentials()).is_some());

        let call = &fetcher.calls()[0];
        assert_eq!(
            call.etag.as_deref(),
            Some("\"v1\""),
            "the ETag is sent back"
        );
        let sidecar = sidecar_of(&root, &key);
        assert_eq!(
            sidecar.validated_at, expired_at,
            "304 restarts the freshness window"
        );
        assert_eq!(
            sidecar.fetched_at, 1_000,
            "the object itself was not refetched"
        );
        assert_eq!(
            std::fs::read(root.objects().join(format!("{}.bin", digest_of(&key)))).expect("object"),
            object,
            "304 keeps the bytes"
        );
    }

    #[test]
    fn a_failed_revalidation_still_serves_the_stale_object() {
        let root = TempRoot::new("stale-fallback");
        let (clock, now) = test_clock(1_000);
        let seed = store(
            &root,
            StubFetcher::new([Stub::png(None)]),
            Arc::clone(&clock),
            Limits::default(),
        );
        let key = key("/thumb/1");
        assert!(seed.load(&key, &credentials()).is_some());
        drop(seed);

        now.store(1_000 + 40 * DAY_MS, Ordering::SeqCst);
        let fetcher = StubFetcher::new([Stub::Failure("fetch failed".to_owned())]);
        let reopened = store(&root, Arc::clone(&fetcher), clock, Limits::default());
        assert!(
            reopened.load(&key, &credentials()).is_some(),
            "the cached object outlives a failed refresh"
        );
        assert_eq!(fetcher.call_count(), 1);
    }

    #[test]
    fn a_stale_object_is_served_now_and_refreshed_in_the_background() {
        let root = TempRoot::new("swr");
        let (clock, now) = test_clock(1_000);
        let seed = store(
            &root,
            StubFetcher::new([Stub::png(None)]),
            Arc::clone(&clock),
            Limits::default(),
        );
        let key = key("/thumb/1");
        assert!(seed.load(&key, &credentials()).is_some());
        drop(seed);

        // Inside the stale-while-revalidate window: served immediately.
        let stale_at = 1_000 + 8 * DAY_MS;
        now.store(stale_at, Ordering::SeqCst);
        let fetcher = StubFetcher::new([Stub::png(Some("\"v2\""))]);
        let reopened = store(&root, Arc::clone(&fetcher), clock, Limits::default());
        assert!(reopened.load(&key, &credentials()).is_some());

        // The refresh runs on its own thread; wait for it to land.
        let refreshed = (0..400).any(|_| {
            std::thread::sleep(std::time::Duration::from_millis(5));
            sidecar_of(&root, &key).validated_at == stale_at
        });
        assert!(refreshed, "the background refresh never updated the object");
        assert_eq!(fetcher.call_count(), 1);
        assert_eq!(sidecar_of(&root, &key).etag.as_deref(), Some("\"v2\""));
    }

    #[test]
    fn concurrent_loads_collapse_onto_one_fetch() {
        let root = TempRoot::new("dedupe");
        let fetcher = StubFetcher::new([Stub::png(None)]);
        let (clock, _) = test_clock(1_000);
        let store = store(&root, Arc::clone(&fetcher), clock, Limits::default());

        let key = key("/thumb/1");
        std::thread::scope(|scope| {
            for _ in 0..8 {
                let store = &store;
                let key = key.clone();
                scope.spawn(move || {
                    assert!(store.load(&key, &credentials()).is_some());
                });
            }
        });
        assert_eq!(
            fetcher.call_count(),
            1,
            "the losers reuse the winner's object"
        );
    }

    #[test]
    fn eviction_drops_the_least_recently_accessed_object() {
        let root = TempRoot::new("evict-entries");
        let (clock, now) = test_clock(1_000);
        let limits = Limits {
            max_entries: 2,
            // Force every read back through the disk so the access times move.
            memory_max_entries: 1,
            ..Limits::default()
        };
        let store = store(&root, StubFetcher::new([Stub::png(None)]), clock, limits);

        let credentials = credentials();
        assert!(store.load(&key("/thumb/1"), &credentials).is_some());
        now.store(2_000, Ordering::SeqCst);
        assert!(store.load(&key("/thumb/2"), &credentials).is_some());
        // Re-reading the first object makes the second the oldest.
        now.store(3_000, Ordering::SeqCst);
        assert!(store.load(&key("/thumb/1"), &credentials).is_some());
        now.store(4_000, Ordering::SeqCst);
        assert!(store.load(&key("/thumb/3"), &credentials).is_some());

        let objects = root.objects();
        assert!(
            objects
                .join(format!("{}.bin", digest_of(&key("/thumb/1"))))
                .exists()
        );
        assert!(
            objects
                .join(format!("{}.bin", digest_of(&key("/thumb/3"))))
                .exists()
        );
        let evicted = digest_of(&key("/thumb/2"));
        assert!(!objects.join(format!("{evicted}.bin")).exists());
        assert!(
            !objects.join(format!("{evicted}.json")).exists(),
            "the sidecar goes with the object"
        );
    }

    #[test]
    fn eviction_also_honours_the_byte_budget() {
        let root = TempRoot::new("evict-bytes");
        let (clock, now) = test_clock(1_000);
        let object_bytes = png_bytes(4, 4).len() as u64;
        let limits = Limits {
            max_bytes: object_bytes * 2,
            memory_max_entries: 1,
            ..Limits::default()
        };
        let store = store(&root, StubFetcher::new([Stub::png(None)]), clock, limits);

        let credentials = credentials();
        for (index, source) in ["/thumb/1", "/thumb/2", "/thumb/3"].iter().enumerate() {
            now.store(1_000 + index as u64 * 1_000, Ordering::SeqCst);
            assert!(store.load(&key(source), &credentials).is_some());
        }

        let remaining = std::fs::read_dir(root.objects())
            .expect("objects")
            .flatten()
            .filter(|entry| entry.file_name().to_string_lossy().ends_with(".bin"))
            .count();
        assert_eq!(remaining, 2, "the cache stays inside its byte budget");
        assert!(
            !root
                .objects()
                .join(format!("{}.bin", digest_of(&key("/thumb/1"))))
                .exists(),
            "the oldest object is the one that goes"
        );
    }

    #[test]
    fn clearing_a_namespace_leaves_every_other_namespace_alone() {
        let root = TempRoot::new("clear");
        let (clock, _) = test_clock(1_000);
        let store = store(
            &root,
            StubFetcher::new([Stub::png(None)]),
            clock,
            Limits::default(),
        );

        let mine = key("/thumb/1");
        let theirs = ArtworkKey {
            namespace: Namespace {
                account_id: "alexr".to_owned(),
                server_id: "studio-id".to_owned(),
            },
            source: Source::Server("/thumb/1".to_owned()),
            variant: Variant::Native,
        };
        // Both frames stay owned here, so the weak memory map can still see
        // them and the clear is the only thing that can take one away.
        let _mine_frame = store.load(&mine, &credentials()).expect("artwork");
        let _theirs_frame = store.load(&theirs, &credentials()).expect("artwork");

        store.clear_namespace(&namespace());
        assert!(
            store.peek(&mine).is_none(),
            "the memory cache is cleared too"
        );
        assert!(store.peek(&theirs).is_some());
        assert!(
            !root
                .objects()
                .join(format!("{}.bin", digest_of(&mine)))
                .exists()
        );
        assert!(
            root.objects()
                .join(format!("{}.bin", digest_of(&theirs)))
                .exists()
        );
    }

    #[test]
    fn the_scan_deletes_half_written_and_unsafe_entries() {
        let root = TempRoot::new("scan");
        let (clock, _) = test_clock(1_000);
        let seed = store(
            &root,
            StubFetcher::new([Stub::png(None)]),
            Arc::clone(&clock),
            Limits::default(),
        );
        let kept = key("/thumb/1");
        assert!(seed.load(&kept, &credentials()).is_some());
        drop(seed);

        let objects = root.objects();
        let orphan_object = "a".repeat(64);
        let orphan_sidecar = "b".repeat(64);
        std::fs::write(objects.join(format!("{orphan_object}.bin")), b"x").expect("write");
        std::fs::write(objects.join(format!("{orphan_sidecar}.json")), b"{}").expect("write");
        std::fs::write(objects.join("half-written.bin.abc.tmp"), b"x").expect("write");

        // A sidecar whose metadata smuggles token material must not survive.
        let unsafe_digest = "c".repeat(64);
        let mut unsafe_sidecar = sidecar_of(&root, &kept);
        unsafe_sidecar.source = "/thumb/9?x-plex-token=secret".to_owned();
        std::fs::write(
            objects.join(format!("{unsafe_digest}.json")),
            serde_json::to_vec(&unsafe_sidecar).expect("json"),
        )
        .expect("write");
        std::fs::write(
            objects.join(format!("{unsafe_digest}.bin")),
            png_bytes(4, 4),
        )
        .expect("write");

        let reopened = store(
            &root,
            StubFetcher::new([Stub::png(None)]),
            clock,
            Limits::default(),
        );
        assert!(
            reopened.load(&kept, &credentials()).is_some(),
            "the good object survives"
        );

        assert!(!objects.join(format!("{orphan_object}.bin")).exists());
        assert!(!objects.join(format!("{orphan_sidecar}.json")).exists());
        assert!(!objects.join("half-written.bin.abc.tmp").exists());
        assert!(!objects.join(format!("{unsafe_digest}.bin")).exists());
        assert!(!objects.join(format!("{unsafe_digest}.json")).exists());
    }

    #[test]
    fn a_namespace_clear_beats_a_fetch_that_is_already_running() {
        let root = TempRoot::new("clear-race");
        let fetcher = StubFetcher::new([Stub::png(None)]);
        let (started_sender, started) = mpsc::channel();
        let (release, release_receiver) = mpsc::channel();
        *lock(&fetcher.gate) = Some((started_sender, release_receiver));
        let (clock, _) = test_clock(1_000);
        let store = store(&root, Arc::clone(&fetcher), clock, Limits::default());

        let key = key("/thumb/1");
        std::thread::scope(|scope| {
            let loading = scope.spawn(|| store.load(&key, &credentials()));
            started.recv().expect("the fetch started");
            store.clear_namespace(&namespace());
            release.send(()).expect("release the fetch");
            assert!(
                loading.join().expect("join").is_none(),
                "an invalidated fetch resolves to nothing"
            );
        });

        let objects = std::fs::read_dir(root.objects())
            .expect("objects")
            .flatten()
            .count();
        assert_eq!(objects, 0, "the cleared namespace stays cleared");
    }

    #[test]
    fn account_artwork_is_fetched_from_plex_tv() {
        let root = TempRoot::new("account");
        let fetcher = StubFetcher::new([Stub::png(None)]);
        let (clock, _) = test_clock(1_000);
        let store = store(&root, Arc::clone(&fetcher), clock, Limits::default());

        let key = ArtworkKey {
            namespace: Namespace::account(Some("alexr"), "client-id").expect("namespace"),
            source: Source::Account("https://plex.tv/users/abc/avatar?c=1".to_owned()),
            variant: Variant::Native,
        };
        assert!(store.load(&key, &credentials()).is_some());
        let call = &fetcher.calls()[0];
        assert_eq!(call.base_url, "https://plex.tv");
        assert_eq!(call.source, "/users/abc/avatar?c=1");
    }

    /// A live round trip against the signed-in server: cold fetch, then a
    /// restart that must find the object on disk.
    /// `cargo test -- --ignored live_artwork`.
    #[test]
    #[ignore = "requires a signed-in config and a reachable Plex server"]
    fn live_artwork_survives_a_restart() {
        let config = crate::plex::load_config().expect("sign in first: no plex-config.json");
        let server = config
            .server
            .clone()
            .expect("no server selected in the config");
        let namespace = Namespace::server(
            config
                .account
                .as_ref()
                .map(|account| account.username.as_str()),
            &config.client_identifier,
            server.client_identifier.as_deref(),
            &server.url,
        )
        .expect("namespace");
        let hubs = crate::plex::get_home_hubs(&server).expect("home hubs");
        let thumb = hubs
            .iter()
            .flat_map(|hub| hub.items.iter())
            .find_map(|item| item.thumb.clone())
            .expect("a hub item with artwork");

        let root = TempRoot::new("live");
        let credentials = Credentials {
            base_url: server.url.clone(),
            token: server.token.clone(),
        };
        let key = ArtworkKey {
            namespace,
            source: Source::Server(thumb.clone()),
            variant: Variant::Native,
        };

        let cold = ArtworkStore::new(root.path());
        assert!(
            cold.load(&key, &credentials).is_some(),
            "cold load of {thumb}"
        );
        let object = root.objects().join(format!("{}.bin", digest_of(&key)));
        assert!(object.exists(), "the object was not written to disk");
        drop(cold);

        let warm = ArtworkStore::new(root.path());
        assert!(
            warm.peek(&key).is_none(),
            "a new store starts with an empty memory cache"
        );
        assert!(
            warm.load(&key, &credentials).is_some(),
            "warm load of {thumb}"
        );
    }

    #[test]
    fn a_non_image_response_is_not_cached() {
        let root = TempRoot::new("not-an-image");
        let fetcher = StubFetcher::new([Stub::Image {
            data: b"<html>nope</html>".to_vec(),
            content_type: "text/html".to_owned(),
            etag: None,
        }]);
        let (clock, _) = test_clock(1_000);
        let store = store(&root, Arc::clone(&fetcher), clock, Limits::default());

        assert!(store.load(&key("/thumb/1"), &credentials()).is_none());
        let objects = std::fs::read_dir(root.objects())
            .map(|entries| entries.flatten().count())
            .unwrap_or_default();
        assert_eq!(objects, 0, "nothing is written for an invalid response");
    }
}
