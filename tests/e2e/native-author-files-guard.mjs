/** Guards shared by the disposable runner and its real HTTP journey. No app imports. */
import { isIP } from 'node:net';

export function nativeProjectId(uuid) {
  if (typeof uuid !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(uuid)) {
    throw new Error('Expected a generated UUID for the disposable project.');
  }
  // CLI 2.120 truncates configured IDs to 40 characters, but not stop's explicit filter.
  return `bwk-${uuid.replaceAll('-', '')}`;
}

export function ownedInternalAddress(container, networkId) {
  const networks = Object.values(container?.NetworkSettings?.Networks ?? {});
  const host = networks[0]?.IPAddress;
  if (!/^[a-f0-9]{64}$/.test(networkId) || container?.State?.Running !== true
    || networks.length !== 1 || networks[0].NetworkID !== networkId
    || typeof host !== 'string' || isIP(host) !== 4
    || !/^(?:10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.)/.test(host)
    || Object.values(container.NetworkSettings.Ports ?? {}).some(bindings => bindings?.length)) {
    throw new Error('Expected a running, unexposed container on the exact owned internal network.');
  }
  return host;
}

export function migrationFiles(names) {
  const files = names.filter(name => name.endsWith('.sql')).sort();
  const versions = new Set();
  for (const name of files) {
    const match = /^(\d+)_[a-z0-9_]+\.sql$/.exec(name);
    if (!match || versions.has(match[1])) throw new Error('Invalid or duplicate repository migration version.');
    versions.add(match[1]);
  }
  if (!files.includes('0001_extensions.sql') || !files.includes('20260912175000_pgcrypto_digest_compatibility.sql')
    || !files.includes('20261013110000_canonical_import_reading_text.sql')) {
    throw new Error('Missing original, pgcrypto compatibility or canonical import migration.');
  }
  return files;
}

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

export function nativeAuthorEnvironment(setup, source = process.env) {
  return { ...childEnvironment(source), NODE_ENV: 'production', LOG_LEVEL: 'error',
    SUPABASE_URL: setup.url, SUPABASE_ANON_KEY: setup.anonKey, SUPABASE_SERVICE_ROLE_KEY: setup.serviceKey,
    REDIS_URL: 'redis://127.0.0.1:59998', QDRANT_URL: 'http://127.0.0.1:59999',
    SCANNING_SERVICE_URL: setup.scannerUrl, SCANNING_SERVICE_TOKEN: setup.serviceToken,
    DOCUMENT_SERVICE_URL: setup.documentUrl, DOCUMENT_SERVICE_TOKEN: setup.serviceToken,
    OPENAI_API_KEY: '', STRIPE_SECRET_KEY: '', STRIPE_WEBHOOK_SECRET: '',
  };
}

export function nativeWebEnvironment(setup, webOrigin, apiOrigin, source = process.env) {
  const supabase = localOrigin(setup.url), web = localOrigin(webOrigin), api = localOrigin(apiOrigin);
  if (supabase !== 'http://127.0.0.1:55321' || new Set([supabase, web, api]).size !== 3) {
    throw new Error('Native browser requires distinct owned web, API and Supabase origins.');
  }
  return { ...childEnvironment(source), NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1',
    BOOKWORM_DIST_DIR: '.next-native-author', APP_URL: web, API_URL: api,
    SUPABASE_URL: supabase, SUPABASE_ANON_KEY: setup.anonKey,
  };
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
