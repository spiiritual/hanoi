import { expect, test } from "bun:test";
import { serverStatusClass, serverStatusLabel } from "../src/mainview/sidebar/utils.ts";

test("offline servers keep an offline status in the selector", () => {
  expect(serverStatusLabel(false)).toBe("○ Offline");
  expect(serverStatusLabel(true)).toBe("● Online");
  expect(serverStatusClass(false)).toBe("is-offline");
  expect(serverStatusClass(true)).toBe("is-online");
});

test("unknown server status stays visibly pending", () => {
  expect(serverStatusLabel(undefined)).toBe("Checking…");
  expect(serverStatusClass(undefined)).toBe("is-checking");
});
