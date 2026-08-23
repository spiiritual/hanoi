import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "hello-world",
		identifier: "helloworld.electrobun.dev",
		version: "0.0.1",
	},
	build: {
		mainProcess: "cottontail",
		cottontail: {
			entrypoint: "src/bun/index.ts",
		},
		views: {
			mainview: {
				entrypoint: "src/mainview/index.tsx",
			},
		},
		copy: {
			"src/mainview/index.html": "views/mainview/index.html",
			"src/mainview/index.css": "views/mainview/index.css",
			"src/mainview/styles/global.css": "views/mainview/styles/global.css",
			"src/mainview/auth/AuthLayout.css": "views/mainview/auth/AuthLayout.css",
			"src/mainview/auth/OAuthScreen.css": "views/mainview/auth/OAuthScreen.css",
			"src/mainview/auth/ConnectedScreen.css":
				"views/mainview/auth/ConnectedScreen.css",
			"src/mainview/auth/ServerSelection.css":
				"views/mainview/auth/ServerSelection.css",
			"src/mainview/home/HomeScreen.css": "views/mainview/home/HomeScreen.css",
			"src/mainview/home/HomeContent.css": "views/mainview/home/HomeContent.css",
			"src/mainview/album/AlbumScreen.css": "views/mainview/album/AlbumScreen.css",
			"src/mainview/sidebar/Sidebar.css": "views/mainview/sidebar/Sidebar.css",
			"src/mainview/player/PlayerBar.css": "views/mainview/player/PlayerBar.css",
			"src/mainview/player/NowPlaying.css": "views/mainview/player/NowPlaying.css",
			"src/mainview/player/PlaybackControls.css":
				"views/mainview/player/PlaybackControls.css",
			"src/mainview/player/VolumeControls.css":
				"views/mainview/player/VolumeControls.css",
		},
		mac: {
			bundleCEF: false,
		},
		linux: {
			bundleCEF: false,
		},
		win: {
			bundleCEF: false,
		},
	},
} satisfies ElectrobunConfig;
