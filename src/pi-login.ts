/** OAuth-only view of Pi's native, cross-process locked AuthStorage.
 * Never call AuthStorage.read(): stored API-key entries may execute shell commands.
 * modify(... => undefined) reads under the native lock without changing credentials.
 */
export function loginCredentialStore(storage: any, provider: string) {
  const checkProvider = (id: string) => {
    if (id !== provider) throw new Error('Credential access is restricted to the selected provider');
  };
  const checkCredential = (value: any) => {
    if (!value || value.type !== 'oauth' || typeof value.access !== 'string' ||
      typeof value.refresh !== 'string' || !Number.isFinite(value.expires)) {
      throw new Error('No usable saved Pi OAuth login. Run Pi /login for the selected provider.');
    }
    return value;
  };
  const safely = async (operation: () => Promise<any>) => {
    try { return await operation(); }
    catch { throw new Error('Pi saved-login access or refresh failed. Reopen Pi and use /login; credential details are hidden.'); }
  };
  return {
    read: async (id: string, options?: unknown) => {
      checkProvider(id);
      return safely(async () => {
        let credential: unknown;
        await storage.modify(id, async (current: unknown) => {
          credential = structuredClone(checkCredential(current));
          return undefined;
        }, options);
        return credential;
      });
    },
    modify: async (id: string, fn: (current: any) => Promise<any>, options?: unknown) => {
      checkProvider(id);
      return safely(() => storage.modify(id, async (current: unknown) => {
        const next = await fn(structuredClone(checkCredential(current)));
        return next === undefined ? undefined : checkCredential(next);
      }, options));
    },
    list: async () => [{ providerId: provider, type: 'oauth' as const }],
    delete: async () => { throw new Error('Use Pi /logout to remove credentials'); },
  };
}
