import { PROVIDERS } from "../registry/providers.js";

const ENV_BY_PROVIDER = new Map(PROVIDERS.map((provider) => [provider.id, provider.credentialEnv]));

/** Standalone-mode credentials (§4.6): resolve each provider's documented env var. Empty values count as unset. */
export function envCredentials(env: Record<string, string | undefined> = process.env): (providerId: string) => string | undefined {
  return (providerId) => {
    const name = ENV_BY_PROVIDER.get(providerId);
    const value = name === undefined ? undefined : env[name];
    return value === undefined || value === "" ? undefined : value;
  };
}
