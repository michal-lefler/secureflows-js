import test from 'node:test';
import assert from 'node:assert/strict';

import { SecureFlows, sessionStorageKeys } from '../../src/secureFlows.js';
import { attachPageHide } from '../helpers/windowMock.js';
import { createSessionStorageMock, installSessionStorage } from '../helpers/sessionStorageMock.js';

/**
 * End-to-end browser simulation: two secureFlows apps on the same origin must keep
 * independent session tokens in sessionStorage.
 */
test('integration: two apps on same origin retain separate tokens through login callbacks', async () => {
  const storage = createSessionStorageMock();
  const restoreStorage = installSessionStorage(storage);

  const win = {
    location: {
      href: 'http://localhost:3000/callback?sessionToken=token-app-a&state=state-a',
      origin: 'http://localhost:3000',
      pathname: '/callback',
      assign: (_url: string) => {},
      replace: (_url: string) => {},
    },
    history: {
      replaceState: (_state: unknown, _title: string, url: string) => {
        win.location.href = url;
      },
    },
    sessionStorage: storage,
    top: null as unknown,
    self: null as unknown,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  };
  win.top = win;
  win.self = win;

  const previousWindow = globalThis.window;
  const previousHistory = globalThis.history;
  const previousDocument = globalThis.document;
  globalThis.window = win as unknown as Window & typeof globalThis;
  globalThis.history = win.history as unknown as History;
  globalThis.document = { title: 'callback' } as Document;

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  const sfA = new SecureFlows({
    origin: 'https://www.secure-flows.com',
    appId: 'app-a',
    workspace: 'demo',
  });
  const sfB = new SecureFlows({
    origin: 'https://www.secure-flows.com',
    appId: 'app-b',
    workspace: 'demo',
  });

  try {
    storage.set(sessionStorageKeys('app-a', 'demo').stateKey, 'state-a');
    const sessionA = await sfA.login({ redirectUri: 'http://localhost:3000/callback' });
    assert.deepEqual(sessionA, { ok: true });
    assert.equal(storage.get(sessionStorageKeys('app-a', 'demo').tokenKey), 'token-app-a');
    assert.equal(sfA.getToken(), 'token-app-a');
    assert.equal(sfB.getToken(), null);

    win.location.href = 'http://localhost:3000/callback?sessionToken=token-app-b&state=state-b';
    storage.set(sessionStorageKeys('app-b', 'demo').stateKey, 'state-b');
    const sessionB = await sfB.login({ redirectUri: 'http://localhost:3000/callback' });
    assert.deepEqual(sessionB, { ok: true });
    assert.equal(storage.get(sessionStorageKeys('app-b', 'demo').tokenKey), 'token-app-b');
    assert.equal(sfA.getToken(), 'token-app-a');
    assert.equal(sfB.getToken(), 'token-app-b');

    sfA.logout();
    assert.equal(sfA.getToken(), null);
    assert.equal(sfB.getToken(), 'token-app-b');
    assert.equal(storage.get(sessionStorageKeys('app-a', 'demo').tokenKey), undefined);
    assert.equal(storage.get(sessionStorageKeys('app-b', 'demo').tokenKey), 'token-app-b');
  } finally {
    globalThis.fetch = origFetch;
    globalThis.window = previousWindow;
    globalThis.history = previousHistory;
    if (previousDocument) {
      globalThis.document = previousDocument;
    } else {
      delete (globalThis as { document?: Document }).document;
    }
    restoreStorage();
  }
});

test('integration: hosted login for app A does not overwrite app B stored token', async () => {
  const storage = createSessionStorageMock({
    [sessionStorageKeys('app-b', 'demo').tokenKey]: 'existing-b',
  });
  const restoreStorage = installSessionStorage(storage);

  let assigned = '';
  const win = {
    location: {
      href: 'http://localhost:3000/',
      origin: 'http://localhost:3000',
      pathname: '/',
      assign: (url: string) => {
        assigned = url;
        (win as EventTarget & { dispatchPageHide?: () => void }).dispatchPageHide?.();
      },
    },
    sessionStorage: storage,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    top: null as unknown,
    self: null as unknown,
  } as {
    location: { href: string; origin: string; pathname: string; assign: (url: string) => void };
    sessionStorage: typeof storage;
    setTimeout: typeof globalThis.setTimeout;
    clearTimeout: typeof globalThis.clearTimeout;
    top: typeof win;
    self: typeof win;
  };
  win.top = win;
  win.self = win;
  attachPageHide(win);

  const previousWindow = globalThis.window;
  globalThis.window = win as unknown as Window & typeof globalThis;

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('gone', { status: 410 });

  const sfA = new SecureFlows({
    origin: 'https://www.secure-flows.com',
    appId: 'app-a',
    workspace: 'demo',
  });
  const sfB = new SecureFlows({
    origin: 'https://www.secure-flows.com',
    appId: 'app-b',
    workspace: 'demo',
  });

  try {
    assert.equal(sfB.getToken(), 'existing-b');
    void sfA.login({ redirectUri: 'http://localhost:3000/callback' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(assigned.includes('/app/sessions/login'));
    assert.ok(assigned.includes('app_id=app-a'));
    assert.equal(sfB.getToken(), 'existing-b');
    assert.ok(storage.has(sessionStorageKeys('app-a', 'demo').stateKey));
    assert.equal(storage.get(sessionStorageKeys('app-b', 'demo').tokenKey), 'existing-b');
  } finally {
    globalThis.fetch = origFetch;
    globalThis.window = previousWindow;
    restoreStorage();
  }
});
