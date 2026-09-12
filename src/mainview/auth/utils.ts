export const hydrateAccountIfMissing = async <T>(
  account: T | null | undefined,
  loadAccount: () => Promise<T>
): Promise<T | null> => account ?? (await loadAccount());

/**
 * The authorization poll's error text, or null when the attempt is healthy.
 *
 * `getAuthState` reports "no error" as `undefined` rather than `null` (the
 * main process normalises it at the RPC boundary), so callers must not treat
 * a merely non-null value as a failure — that renders the literal string
 * "undefined" at the user and stops the poll on every healthy tick.
 */
export const authErrorMessage = (
  authError: string | null = ""
): string | null =>
  authError === null || authError.length === 0 ? null : authError;
