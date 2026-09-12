import { expect, test } from "bun:test";

import { authErrorMessage } from "../src/mainview/auth/utils.ts";

test("a healthy poll reports no error however absence is spelled", () => {
  // getAuthState sends undefined for "no error"; null and "" are the other
  // shapes the value has taken across the RPC boundary.
  expect(authErrorMessage()).toBeNull();
  expect(authErrorMessage(null)).toBeNull();
  expect(authErrorMessage("")).toBeNull();
});

test("a real authorization failure is surfaced verbatim", () => {
  expect(authErrorMessage("Timed out waiting for Plex authorization")).toBe(
    "Timed out waiting for Plex authorization"
  );
});

test("an absent error never becomes user-visible text", () => {
  // Regression: `authError !== null` passed for undefined, rendering the
  // literal "Something went wrong: undefined" and halting the poll.
  for (const absent of [undefined, null, ""]) {
    const message = authErrorMessage(absent);
    expect(`${message}`).not.toContain("undefined");
  }
});
