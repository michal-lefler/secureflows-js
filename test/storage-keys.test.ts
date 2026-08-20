import test from 'node:test';
import assert from 'node:assert/strict';

import { SecureFlows, sessionStorageKeys } from '../src/secureFlows.js';
import { createSessionStorageMock, installSessionStorage } from './helpers/sessionStorageMock.js';

test('sessionStorageKeys trims appId whitespace', () => {
  assert.deepEqual(sessionStorageKeys('  myapp  '), sessionStorageKeys('myapp'));
});

test('sessionStorageKeys rejects whitespace-only appId', () => {
  assert.throws(() => sessionStorageKeys('   '), /appId is required/);
});

test('getToken prefers per-app+workspace key over per-app key and legacy sf.token', () => {
  const storage = createSessionStorageMock({
    [sessionStorageKeys('myapp', 'ws').tokenKey]: 'scoped-v2-token',
    'sf.token.myapp': 'scoped-v1-token',
    'sf.token': 'legacy-token',
  });
  const restore = installSessionStorage(storage);

  const sf = new SecureFlows({
    origin: 'https://www.secure-flows.com',
    appId: 'myapp',
    workspace: 'ws',
  });

  try {
    assert.equal(sf.getToken(), 'scoped-v2-token');
    assert.equal(storage.get('sf.token'), 'legacy-token');
  } finally {
    restore();
  }
});

test('logout clears only scoped state and token keys', () => {
  const storage = createSessionStorageMock({
    [sessionStorageKeys('app-a', 'ws').tokenKey]: 'token-a',
    [sessionStorageKeys('app-a', 'ws').stateKey]: 'state-a',
    [sessionStorageKeys('app-b', 'ws').tokenKey]: 'token-b',
    [sessionStorageKeys('app-b', 'ws').stateKey]: 'state-b',
  });
  const restore = installSessionStorage(storage);

  const sfA = new SecureFlows({
    origin: 'https://www.secure-flows.com',
    appId: 'app-a',
    workspace: 'ws',
  });

  try {
    sfA.logout();
    assert.equal(storage.get(sessionStorageKeys('app-a', 'ws').tokenKey), undefined);
    assert.equal(storage.get(sessionStorageKeys('app-a', 'ws').stateKey), undefined);
    assert.equal(storage.get(sessionStorageKeys('app-b', 'ws').tokenKey), 'token-b');
    assert.equal(storage.get(sessionStorageKeys('app-b', 'ws').stateKey), 'state-b');
  } finally {
    restore();
  }
});

test('getToken returns null when sessionStorage throws', () => {
  const restore = installSessionStorage({
    get length() {
      return 0;
    },
    clear() {},
    getItem() {
      throw new Error('blocked');
    },
    setItem() {
      throw new Error('blocked');
    },
    removeItem() {
      throw new Error('blocked');
    },
    key() {
      return null;
    },
  } as Storage);

  const sf = new SecureFlows({
    origin: 'https://www.secure-flows.com',
    appId: 'myapp',
    workspace: 'demo',
  });

  try {
    assert.equal(sf.getToken(), null);
  } finally {
    restore();
  }
});

test('legacy migration runs only once', () => {
  const storage = createSessionStorageMock({ 'sf.token': 'legacy-jwt' });
  const restore = installSessionStorage(storage);

  const sf = new SecureFlows({
    origin: 'https://www.secure-flows.com',
    appId: 'myapp',
    workspace: 'demo',
  });

  try {
    assert.equal(sf.getToken(), 'legacy-jwt');
    assert.equal(sf.getToken(), 'legacy-jwt');
    assert.equal(storage.get(sessionStorageKeys('myapp', 'demo').tokenKey), 'legacy-jwt');
    assert.equal(storage.get('sf.token'), undefined);
  } finally {
    restore();
  }
});

test('v1 migration (app-only) does not delete old key', () => {
  const storage = createSessionStorageMock({
    [sessionStorageKeys('myapp').tokenKey]: 'v1-token',
  });
  const restore = installSessionStorage(storage);

  const sf = new SecureFlows({
    origin: 'https://www.secure-flows.com',
    appId: 'myapp',
    workspace: 'demo',
  });

  try {
    assert.equal(sf.getToken(), 'v1-token');
    assert.equal(storage.get(sessionStorageKeys('myapp', 'demo').tokenKey), 'v1-token');
    assert.equal(storage.get(sessionStorageKeys('myapp').tokenKey), 'v1-token');
  } finally {
    restore();
  }
});
