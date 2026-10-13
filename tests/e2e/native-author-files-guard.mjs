/** Guards shared by the disposable runner and its real HTTP journey. No app imports. */
export function requireNativeAuthorRunner(env = process.env, platform = process.platform) {
  if (platform !== 'linux' || env.GITHUB_ACTIONS !== 'true'
    || env.RUNNER_ENVIRONMENT !== 'github-hosted' || env.BOOKWORM_NATIVE_AUTHOR_TEST !== '1') {
    throw new Error('Native author acceptance requires an explicitly enabled GitHub-hosted Linux runner.');
  }
}

export function childEnvironment(source = process.env) {
  // Never inherit app credentials, cloud access tokens, Docker targets, proxies,
  // NODE_OPTIONS or a developer's .env loader into these disposable processes.
  return Object.fromEntries(['PATH', 'HOME', 'LANG', 'TMPDIR', 'GITHUB_ACTIONS', 'RUNNER_ENVIRONMENT',
    'BOOKWORM_NATIVE_AUTHOR_TEST'].filter(key => source[key]).map(key => [key, source[key]]));
}

export function localOrigin(raw) {
  const url = new URL(raw);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Expected an exact loopback HTTP service origin.');
  }
  return url.origin;
}

export function localStatus(raw) {
  const value = JSON.parse(raw);
  if (localOrigin(value.API_URL) !== 'http://127.0.0.1:55321'
    || !['ANON_KEY', 'SERVICE_ROLE_KEY'].every(key => typeof value[key] === 'string'
      && value[key].length >= 20 && value[key].length <= 4096 && !/\s/.test(value[key]))) {
    throw new Error('Disposable Supabase status did not match the owned local stack.');
  }
  return { url: value.API_URL, anonKey: value.ANON_KEY, serviceKey: value.SERVICE_ROLE_KEY };
}

export function localFetch(origins, fetcher = fetch) {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.username || url.password || url.hash || !origins.has(localOrigin(url.origin))) {
      throw new Error('Native author acceptance refused an unowned network destination.');
    }
    const signals = [AbortSignal.timeout(70_000), init?.signal ?? (input instanceof Request ? input.signal : null)].filter(Boolean);
    return fetcher(input, { ...init, redirect: 'error', signal: AbortSignal.any(signals) });
  };
}
