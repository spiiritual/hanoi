import type { ElectrobunConfig } from "electrobun";

export default {
  app: {
    identifier: "helloworld.electrobun.dev",
    name: "hello-world",
    version: "0.0.1",
  },
  build: {
    copy: {
      "src/mainview/album/AlbumScreen.css":
        "views/mainview/album/AlbumScreen.css",
      "src/mainview/artist/ArtistScreen.css":
        "views/mainview/artist/ArtistScreen.css",
      "src/mainview/auth/AuthLayout.css": "views/mainview/auth/AuthLayout.css",
      "src/mainview/auth/ConnectedScreen.css":
        "views/mainview/auth/ConnectedScreen.css",
      "src/mainview/auth/OAuthScreen.css":
        "views/mainview/auth/OAuthScreen.css",
      "src/mainview/auth/ServerSelection.css":
        "views/mainview/auth/ServerSelection.css",
      "src/mainview/fonts/InterVariable.woff2":
        "views/mainview/fonts/InterVariable.woff2",
      "src/mainview/fonts/JetBrainsMono-Bold.woff2":
        "views/mainview/fonts/JetBrainsMono-Bold.woff2",
      "src/mainview/home/HomeContent.css":
        "views/mainview/home/HomeContent.css",
      "src/mainview/home/HomeScreen.css": "views/mainview/home/HomeScreen.css",
      "src/mainview/index.css": "views/mainview/index.css",
      "src/mainview/index.html": "views/mainview/index.html",
      "src/mainview/player/NowPlaying.css":
        "views/mainview/player/NowPlaying.css",
      "src/mainview/player/PlaybackControls.css":
        "views/mainview/player/PlaybackControls.css",
      "src/mainview/player/PlayerBar.css":
        "views/mainview/player/PlayerBar.css",
      "src/mainview/player/VolumeControls.css":
        "views/mainview/player/VolumeControls.css",
      "src/mainview/playlist/PlaylistScreen.css":
        "views/mainview/playlist/PlaylistScreen.css",
      "src/mainview/sidebar/Sidebar.css": "views/mainview/sidebar/Sidebar.css",
      "src/mainview/songs/SongsScreen.css":
        "views/mainview/songs/SongsScreen.css",
      "src/mainview/styles/global.css": "views/mainview/styles/global.css",
    },
    cottontail: {
      entrypoint: "src/bun/index.ts",
    },
    linux: {
      bundleCEF: false,
    },
    mac: {
      bundleCEF: false,
    },
    mainProcess: "cottontail",
    views: {
      mainview: {
        entrypoint: "src/mainview/index.tsx",
      },
    },
    win: {
      bundleCEF: false,
    },
  },
} satisfies ElectrobunConfig;
