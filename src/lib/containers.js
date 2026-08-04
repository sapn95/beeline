// Firefox containers, a.k.a. contextual identities.
//
// One profile, several signed-in identities: My Apps in a work container lists
// a different tenant's tiles than the same page in another. Beeline therefore
// treats "which container" as part of what an app IS, not as a launch option
// bolted on afterwards.
//
// Chrome has no counterpart at all. Every entry point here answers "there are
// no containers" rather than throwing, so the same code runs on both builds and
// the Chrome bundle carries no dead branches of its own.
//
// The feature can also be off on Firefox: the user may set
// privacy.userContext.enabled to false, and then the API is either missing
// outright or its promises reject. Both look the same from here — no containers.

/** The ordinary, container-less browsing context. */
export const DEFAULT_STORE = 'firefox-default';

/** Does this cookie store id name a real container? */
export function isContained(cookieStoreId) {
  return (
    typeof cookieStoreId === 'string' &&
    cookieStoreId !== '' &&
    cookieStoreId !== DEFAULT_STORE &&
    // A private window has its own store, which no app should ever be pinned to:
    // it is gone when the window closes.
    !cookieStoreId.startsWith('firefox-private')
  );
}

// Firefox exposes promise-style APIs on `browser`; Chrome MV3 on `chrome`. The
// namespace is absent entirely when the permission is not granted, which is
// exactly the "feature is off" case.
function identitiesApi() {
  return (
    globalThis.browser?.contextualIdentities ?? globalThis.chrome?.contextualIdentities ?? null
  );
}

function permissionsApi() {
  return globalThis.browser?.permissions ?? globalThis.chrome?.permissions ?? null;
}

/**
 * Every container this browser has, newest-first as Firefox orders them.
 * Resolves to [] on Chrome, when the user has switched containers off, or when
 * the query fails — a browser without containers must not break the launcher.
 * @returns {Promise<Array<{cookieStoreId: string, name: string, color?: string, icon?: string}>>}
 */
export async function listContainers() {
  const api = identitiesApi();
  if (!api?.query) return [];
  try {
    const found = await api.query({});
    if (!Array.isArray(found)) return [];
    return found
      .filter((c) => isContained(c?.cookieStoreId))
      .map((c) => ({
        cookieStoreId: c.cookieStoreId,
        name: String(c.name ?? '').trim() || c.cookieStoreId,
        color: c.color,
        icon: c.icon,
      }));
  } catch {
    return []; // privacy.userContext.enabled is false, or the API is not there
  }
}

/**
 * Name a single container for display. Falls back to the raw store id, which is
 * ugly but honest: better than a blank chip on a row that really is pinned to
 * something. Resolves to '' for the default store.
 */
export async function containerName(cookieStoreId) {
  if (!isContained(cookieStoreId)) return '';
  const api = identitiesApi();
  if (!api?.get) return cookieStoreId;
  try {
    const found = await api.get(cookieStoreId);
    return String(found?.name ?? '').trim() || cookieStoreId;
  } catch {
    // Removing a container leaves apps behind that still name it. Say so with
    // the id rather than pretending the app has no container.
    return cookieStoreId;
  }
}

/** `cookies` is what makes tabs.create/windows.create honour a cookieStoreId. */
const COOKIES_PERMISSION = { permissions: ['cookies'] };

export async function hasCookiesPermission() {
  const api = permissionsApi();
  if (!api?.contains) return false;
  try {
    return await api.contains(COOKIES_PERMISSION);
  } catch {
    return false;
  }
}

/**
 * Ask for `cookies`. Firefox grants this one silently — it is on the list that
 * needs no prompt — so this is not the intrusion the name suggests, and it is
 * only ever reached once the user has picked a container.
 */
export async function requestCookiesPermission() {
  const api = permissionsApi();
  if (!api?.request) return false;
  try {
    return await api.request(COOKIES_PERMISSION);
  } catch {
    return false;
  }
}

/**
 * Spread a `cookieStoreId` into tabs.create / windows.create options — but only
 * when there is a real container AND the permission to honour it. Without the
 * permission Firefox rejects the whole call, which would turn "open this app"
 * into "nothing happens"; opening in the default container is the far better
 * failure.
 */
export async function withContainer(options, cookieStoreId) {
  if (!isContained(cookieStoreId)) return options;
  if (!(await hasCookiesPermission())) return options;
  return { ...options, cookieStoreId };
}
