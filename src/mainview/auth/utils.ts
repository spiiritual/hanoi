export const hydrateAccountIfMissing = async <T>(
  account: T | null | undefined,
  loadAccount: () => Promise<T>
): Promise<T | null> => account ?? (await loadAccount());
