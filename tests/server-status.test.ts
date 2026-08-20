import { expect, test } from "bun:test";
import { serverStatusLabel } from "../src/mainview/server-status.ts";

test("offline servers keep an offline status in the selector", () => {
	expect(serverStatusLabel(false)).toBe("○ Offline");
	expect(serverStatusLabel(true)).toBe("● Online");
});
