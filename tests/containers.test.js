import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  isContained,
  listContainers,
  containerName,
  withContainer,
  hasCookiesPermission,
  requestCookiesPermission,
  DEFAULT_STORE,
} from '../src/lib/containers.js';

const WORK = 'firefox-container-2';

function fakeFirefox({ identities = [], granted = true, throws = false } = {}) {
  globalThis.browser = {
    contextualIdentities: {
      query: vi.fn(async () => {
        if (throws) throw new Error('privacy.userContext.enabled is false');
        return identities;
      }),
      get: vi.fn(async (id) => {
        if (throws) throw new Error('no such container');
        return identities.find((c) => c.cookieStoreId === id);
      }),
    },
    permissions: { contains: vi.fn(async () => granted) },
  };
}

afterEach(() => {
  delete globalThis.browser;
  delete globalThis.chrome;
  vi.restoreAllMocks();
});

describe('isContained', () => {
  it('accepts a real container and nothing else', () => {
    expect(isContained(WORK)).toBe(true);
    expect(isContained(DEFAULT_STORE)).toBe(false);
    expect(isContained('')).toBe(false);
    expect(isContained(undefined)).toBe(false);
    expect(isContained(7)).toBe(false);
  });

  it('refuses a private window, whose store dies with the window', () => {
    expect(isContained('firefox-private')).toBe(false);
    expect(isContained('firefox-private-1')).toBe(false);
  });
});

describe('listContainers', () => {
  it('answers "none" on a browser without the API — that is Chrome', async () => {
    await expect(listContainers()).resolves.toEqual([]);
  });

  it('answers "none" when the user has switched containers off', async () => {
    // Firefox rejects rather than returning [], and a launcher must not break
    // over a feature the user chose not to have.
    fakeFirefox({ throws: true });
    await expect(listContainers()).resolves.toEqual([]);
  });

  it('lists the containers, dropping the default store', async () => {
    fakeFirefox({
      identities: [
        { cookieStoreId: DEFAULT_STORE, name: 'Default' },
        { cookieStoreId: WORK, name: 'Work', color: 'blue' },
      ],
    });
    await expect(listContainers()).resolves.toEqual([
      { cookieStoreId: WORK, name: 'Work', color: 'blue', icon: undefined },
    ]);
  });

  it('falls back to the store id when a container has no name', async () => {
    fakeFirefox({ identities: [{ cookieStoreId: WORK, name: '  ' }] });
    const [c] = await listContainers();
    expect(c.name).toBe(WORK);
  });
});

describe('containerName', () => {
  it('names a container, and says nothing for the default store', async () => {
    fakeFirefox({ identities: [{ cookieStoreId: WORK, name: 'Work' }] });
    await expect(containerName(WORK)).resolves.toBe('Work');
    await expect(containerName(DEFAULT_STORE)).resolves.toBe('');
  });

  it('shows the raw id for a container that has been deleted', async () => {
    // Apps outlive the container they were imported from. A blank chip would
    // read as "no container" on a row that really is pinned to one.
    fakeFirefox({ throws: true });
    await expect(containerName(WORK)).resolves.toBe(WORK);
  });
});

describe('withContainer', () => {
  it('adds the cookie store id when the permission is there', async () => {
    fakeFirefox({ granted: true });
    await expect(withContainer({ url: 'https://x.example.com/' }, WORK)).resolves.toEqual({
      url: 'https://x.example.com/',
      cookieStoreId: WORK,
    });
  });

  it('drops it without the permission, rather than failing the whole call', async () => {
    // Firefox rejects tabs.create outright if cookieStoreId is passed without
    // `cookies` — the app would simply not open. Wrong container beats nothing.
    fakeFirefox({ granted: false });
    await expect(withContainer({ url: 'https://x.example.com/' }, WORK)).resolves.toEqual({
      url: 'https://x.example.com/',
    });
    await expect(hasCookiesPermission()).resolves.toBe(false);
  });

  it('leaves the options untouched on a browser with no containers', async () => {
    const opts = { url: 'https://x.example.com/' };
    await expect(withContainer(opts, WORK)).resolves.toBe(opts);
    await expect(withContainer(opts, DEFAULT_STORE)).resolves.toBe(opts);
  });
});

describe('requestCookiesPermission', () => {
  it('asks for exactly `cookies` and reports what it got', async () => {
    const request = vi.fn(async () => true);
    globalThis.browser = { permissions: { request } };
    await expect(requestCookiesPermission()).resolves.toBe(true);
    expect(request).toHaveBeenCalledWith({ permissions: ['cookies'] });
  });

  it('reports a refusal rather than assuming it worked', async () => {
    globalThis.browser = { permissions: { request: vi.fn(async () => false) } };
    await expect(requestCookiesPermission()).resolves.toBe(false);
  });

  it('reports false when the API is absent or throws', async () => {
    await expect(requestCookiesPermission()).resolves.toBe(false); // no browser at all
    globalThis.browser = {
      permissions: {
        request: vi.fn(async () => {
          throw new Error('must be called from a user gesture');
        }),
      },
    };
    await expect(requestCookiesPermission()).resolves.toBe(false);
  });
});
