export async function hydrateAccountIfMissing<T>(
  account: T | null | undefined,
  loadAccount: () => Promise<T>,
): Promise<T | null> {
  return account ?? (await loadAccount());
}
