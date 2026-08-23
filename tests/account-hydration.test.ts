import { expect, test } from "bun:test";
import { hydrateAccountIfMissing } from "../src/mainview/auth/utils.ts";

const account = { username: "andrew", email: "andrew@example.com" };

test("missing saved account data is hydrated from Plex", async () => {
	let loadCount = 0;
	const result = await hydrateAccountIfMissing(null, async () => {
		loadCount += 1;
		return account;
	});

	expect(loadCount).toBe(1);
	expect(result).toEqual(account);
});

test("cached account data avoids an unnecessary hydration request", async () => {
	let loadCount = 0;
	const result = await hydrateAccountIfMissing(account, async () => {
		loadCount += 1;
		return account;
	});

	expect(loadCount).toBe(0);
	expect(result).toEqual(account);
});
