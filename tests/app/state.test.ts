// Tests execute with Bun's native test runner.
import { expect, test } from "bun:test";

import { createAppState } from "../../src/mainview/app-state.ts";

const musicSections = [
  { key: "1", title: "Music", type: "artist" },
  { key: "2", title: "Soundtracks", type: "artist" },
];

const loadMusicSections = async () => {
  await Promise.resolve();
  return musicSections;
};

test("shared app state keeps one active view and search query", () => {
  const appState = createAppState({ loadMusicSections });
  appState.setActiveView("albums");
  appState.setSearchQuery("carti");
  expect(appState.getSnapshot()).toMatchObject({
    activeView: "albums",
    searchQuery: "carti",
  });
});

test("app snapshots stay referentially stable between updates", () => {
  const appState = createAppState({ loadMusicSections });
  const first = appState.getSnapshot();
  const second = appState.getSnapshot();
  expect(second).toBe(first);
  appState.setSearchQuery("carti");
  expect(appState.getSnapshot()).not.toBe(first);
});

test("music sections are loaded once and shared across repeated reads", async () => {
  let loadCount = 0;
  const appState = createAppState({
    loadMusicSections: async () => {
      await Promise.resolve();
      loadCount += 1;
      return musicSections;
    },
  });
  appState.setSelectedServer("server-1");
  const [first, second] = await Promise.all([
    appState.loadMusicSections(),
    appState.loadMusicSections(),
  ]);
  expect(loadCount).toBe(1);
  expect(first).toEqual(musicSections);
  expect(second).toEqual(musicSections);
  expect(appState.getSnapshot()).toMatchObject({
    musicSections,
    musicSectionsError: null,
    musicSectionsStatus: "ready",
    selectedServer: "server-1",
  });
});

test("changing servers invalidates the cached music sections", async () => {
  let loadCount = 0;
  const appState = createAppState({
    loadMusicSections: async () => {
      await Promise.resolve();
      loadCount += 1;
      return musicSections;
    },
  });
  appState.setSelectedServer("server-1");
  await appState.loadMusicSections();
  appState.setSelectedServer("server-2");
  await appState.loadMusicSections();
  expect(loadCount).toBe(2);
  expect(appState.getSnapshot().selectedServer).toBe("server-2");
});

test("changing servers advances the search invalidation generation", () => {
  const appState = createAppState({ loadMusicSections });
  appState.setSearchQuery("carti");
  const before = appState.getSnapshot().searchGeneration;
  appState.setSelectedServer("server-1");
  expect(appState.getSnapshot()).toMatchObject({
    searchGeneration: before + 1,
    searchQuery: "carti",
  });
});

test("failed section loads expose an error and can be retried", async () => {
  let loadCount = 0;
  const appState = createAppState({
    loadMusicSections: async () => {
      await Promise.resolve();
      loadCount += 1;
      if (loadCount === 1) {
        throw new Error("Plex unavailable");
      }
      return musicSections;
    },
  });
  appState.setSelectedServer("server-1");
  let failure: unknown;
  try {
    await appState.loadMusicSections();
  } catch (error: unknown) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect(failure).toHaveProperty("message", "Plex unavailable");
  expect(appState.getSnapshot()).toMatchObject({
    musicSectionsError: "Plex unavailable",
    musicSectionsStatus: "error",
  });
  await appState.loadMusicSections();
  expect(loadCount).toBe(2);
  expect(appState.getSnapshot().musicSectionsStatus).toBe("ready");
});
