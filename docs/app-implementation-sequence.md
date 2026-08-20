# Hanoi App Implementation Sequence

This roadmap captures the next slices after the app shell. Each slice should
ship as a usable vertical increment on top of the shared shell.

1. App shell — Pen-matched sidebar, main content frame, top bar space, and
   player-bar space. Use real account and selected-server data.
2. Navigation and shared data state — route/view state for Home, Albums,
   Artists, Songs, Playlists, and Search; load the Plex music section once.
3. Home — Recently Played and Most Played with real Plex data plus loading,
   empty, and error states.
4. Playback — resolve stream URLs, play audio, show now-playing state and
   controls, and scrobble tracks.
5. Albums — album grid, sorting, hover states, album detail, and track list.
6. Artists — artist grid, artist detail, albums, and top songs.
7. Songs — full song list with artwork, artist, duration, and play actions.
8. Playlists — playlist cards, playlist detail, and track playback.
9. Search — grouped Songs, Albums, and Artists results.
10. Secondary interactions and polish — server selector dropdown,
    disconnect/settings actions, keyboard shortcuts, responsive sizing, and
    remaining Pen hover/playing states.

The current implementation session is limited to step 1.
