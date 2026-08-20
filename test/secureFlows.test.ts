import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HostedLoginNavigationError,
  navigateForHostedLogin,
  SecureFlows,
  SecureFlowsHttpError,
  sessionStorageKeys,
} from '../src/secureFlows.js';

function attachPageHide(win: EventTarget): void {
  const target = new EventTarget();
  (win as EventTarget & { dispatchPageHide?: () => void }).addEventListener =
    target.addEventListener.bind(target);
  (win as EventTarget & { dispatchPageHide?: () => void }).removeEventListener =
    target.removeEventListener.bind(target);
  (win as EventTarget & { dispatchPageHide?: () => void }).dispatchPageHide = () => {
    target.dispatchEvent(new Event('pagehide'));
  };
}

test('constructor requires origin, appId, workspace', () => {
  assert.throws(
    () => new SecureFlows({ origin: '', appId: 'a', workspace: 'w' }),
    /SecureFlows requires origin, appId, workspace/,
  );
  assert.throws(
    () => new SecureFlows({ origin: 'https://x.com', appId: '', workspace: 'w' }),
    /SecureFlows requires origin, appId, workspace/,
  );
  assert.throws(
    () => new SecureFlows({ origin: 'https://x.com', appId: 'a', workspace: '' }),
    /SecureFlows requires origin, appId, workspace/,
  );
});

test('buildLoginUrl includes expected query parameters', () => {
  const sf = new SecureFlows({
    origin: 'https://api.example.com',
    appId: 'my-app',
    workspace: 'ws-1',
  });
  const url = sf.buildLoginUrl({
    appId: 'my-app',
    workspace: 'ws-1',
    redirectUri: 'https://client.example.com/cb',
    state: 'abc123',
    ttlSeconds: 3600,
    payload: { role: 'user' },
  });
  assert.equal(url.origin, 'https://api.example.com');
  assert.equal(url.pathname, '/app/sessions/login');
  assert.equal(url.searchParams.get('app_id'), 'my-app');
  assert.equal(url.searchParams.get('workspace_name'), 'ws-1');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://client.example.com/cb');
  assert.equal(url.searchParams.get('state'), 'abc123');
  assert.equal(url.searchParams.get('ttl_seconds'), '3600');
  assert.equal(url.searchParams.get('payload'), JSON.stringify({ role: 'user' }));
});

test('buildLogoutRedirectUrl includes expected query parameters', () => {
  const sf = new SecureFlows({
    origin: 'https://www.secure-flows.com',
    appId: 'a',
    workspace: 'w',
  });
  const url = sf.buildLogoutRedirectUrl({
    sessionToken: 'tok.jwt.value',
    redirectUri: 'https://client.example.com/cb',
  });
  assert.equal(url.origin, 'https://www.secure-flows.com');
  assert.equal(url.pathname, '/api/v1/auth/logout');
  assert.equal(url.searchParams.get('session_token'), 'tok.jwt.value');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://client.example.com/cb');
});

test('extractTokenFromUrl parses OAuth-style redirect parameters', () => {
  const sf = new SecureFlows({
    origin: 'https://api.example.com',
    appId: 'a',
    workspace: 'w',
  });
  const ok = sf.extractTokenFromUrl(
    'https://client.example.com/cb?sessionToken=tok&state=s1',
  );
  assert.equal(ok.sessionToken, 'tok');
  assert.equal(ok.state, 's1');
  assert.equal(ok.error, null);
  assert.equal(ok.errorDescription, null);

  const err = sf.extractTokenFromUrl(
    'https://client.example.com/cb?error=access_denied&error_description=User%20cancelled',
  );
  assert.equal(err.sessionToken, null);
  assert.equal(err.error, 'access_denied');
  assert.ok(err.errorDescription?.includes('User') || err.errorDescription === 'User cancelled');
});

test('login exchanges firebaseToken on callback via auth callback API', async () => {
  const previousWindow = globalThis.window;
  const previousSessionStorage = globalThis.sessionStorage;
  const storage = new Map<string, string>();
  const sessionStorageMock = {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
    removeItem: (k: string) => storage.delete(k),
  };

  let assigned = '';
  const win = {
    location: {
      href: 'https://preview.base44.app/callback?firebaseToken=fb.jwt&state=csrf-1',
      assign: (url: string) => {
        assigned = url;
      },
    },
    sessionStorage: sessionStorageMock,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  };
  globalThis.window = win as unknown as Window & typeof globalThis;
  globalThis.sessionStorage = sessionStorageMock as unknown as Storage;
  storage.set(sessionStorageKeys('notes-app', 'demo-workspace').stateKey, 'csrf-1');

  const sf = new SecureFlows({
    origin: 'https://www.secure-flows.com',
    appId: 'notes-app',
    workspace: 'demo-workspace',
  });

  try {
    void sf.login({ redirectUri: 'https://preview.base44.app/callback' });
    assert.ok(assigned.includes('https://www.secure-flows.com/api/v1/auth/callback'));
    assert.ok(assigned.includes('firebaseToken=fb.jwt'));
    assert.ok(assigned.includes('client_redirect_uri='));
    assert.ok(assigned.includes(encodeURIComponent('https://preview.base44.app/callback')));
    assert.ok(assigned.includes('workspace_name=demo-workspace'));
    assert.ok(assigned.includes('app_id=notes-app'));
    assert.ok(assigned.includes('state=csrf-1'));
  } finally {
    globalThis.window = previousWindow;
    globalThis.sessionStorage = previousSessionStorage;
  }
});

test('buildSessionAuthCallbackUrl includes expected query parameters', () => {
  const sf = new SecureFlows({
    origin: 'https://www.secure-flows.com',
    appId: 'notes-app',
    workspace: 'demo-workspace',
  });
  const url = sf.buildSessionAuthCallbackUrl({
    firebaseToken: 'fb.jwt',
    clientRedirectUri: 'https://preview.base44.app/callback',
    state: 'csrf-1',
  });
  assert.equal(url.pathname, '/api/v1/auth/callback');
  assert.equal(url.searchParams.get('firebaseToken'), 'fb.jwt');
  assert.equal(url.searchParams.get('client_redirect_uri'), 'https://preview.base44.app/callback');
  assert.equal(url.searchParams.get('workspace_name'), 'demo-workspace');
  assert.equal(url.searchParams.get('app_id'), 'notes-app');
  assert.equal(url.searchParams.get('state'), 'csrf-1');
});

test('fetchSession throws SecureFlowsHttpError on non-2xx responses', async () => {
  const sf = new SecureFlows({
    origin: 'https://api.example.com',
    appId: 'a',
    workspace: 'w',
  });

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('expired', { status: 410 });

  try {
    await assert.rejects(sf.fetchSession('session-jwt'), (err: unknown) => {
      assert.ok(err instanceof SecureFlowsHttpError);
      assert.equal((err as SecureFlowsHttpError).status, 410);
      assert.match((err as Error).message, /410/);
      return true;
    });
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('login clears stale token and starts hosted login on 410', async () => {
  const previousWindow = globalThis.window;
  const previousSessionStorage = globalThis.sessionStorage;
  // Old app-only key exists (0.1.11–0.1.12); SDK should migrate into v2 key but not delete old.
  const storage = new Map<string, string>([[sessionStorageKeys('myapp').tokenKey, 'dead-token']]);
  const sessionStorageMock = {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
    removeItem: (k: string) => storage.delete(k),
  };

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
    sessionStorage: sessionStorageMock,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  } as {
    location: { href: string; origin: string; pathname: string; assign: (url: string) => void };
    sessionStorage: typeof sessionStorageMock;
    setTimeout: typeof globalThis.setTimeout;
    clearTimeout: typeof globalThis.clearTimeout;
    top: typeof win;
    self: typeof win;
  };
  win.top = win;
  win.self = win;
  attachPageHide(win);
  globalThis.window = win as unknown as Window & typeof globalThis;
  globalThis.sessionStorage = sessionStorageMock as unknown as Storage;

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('expired', { status: 410 });

  const sf = new SecureFlows({
    origin: 'https://www.secure-flows.com',
    appId: 'myapp',
    workspace: 'demo',
  });

  try {
    void sf.login({ redirectUri: 'http://localhost:3000/callback' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    // New v2 token is cleared; old ambiguous key is left intact for backward compatibility.
    assert.equal(storage.get(sessionStorageKeys('myapp', 'demo').tokenKey), undefined);
    assert.equal(storage.get(sessionStorageKeys('myapp').tokenKey), 'dead-token');
    assert.ok(storage.has(sessionStorageKeys('myapp', 'demo').stateKey));
    assert.ok(assigned.includes('/app/sessions/login'));
    assert.ok(assigned.includes(encodeURIComponent('http://localhost:3000/callback')));
  } finally {
    globalThis.fetch = origFetch;
    globalThis.window = previousWindow;
    globalThis.sessionStorage = previousSessionStorage;
  }
});

test('login clears stale token on legacy 403 Access denied (expired JWT)', async () => {
  const previousWindow = globalThis.window;
  const previousSessionStorage = globalThis.sessionStorage;
  const keys = sessionStorageKeys('myapp', 'demo');
  const storage = new Map<string, string>([[keys.tokenKey, 'dead-token']]);
  const sessionStorageMock = {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
    removeItem: (k: string) => storage.delete(k),
  };

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
    sessionStorage: sessionStorageMock,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  } as {
    location: { href: string; origin: string; pathname: string; assign: (url: string) => void };
    sessionStorage: typeof sessionStorageMock;
    setTimeout: typeof globalThis.setTimeout;
    clearTimeout: typeof globalThis.clearTimeout;
    top: typeof win;
    self: typeof win;
  };
  win.top = win;
  win.self = win;
  attachPageHide(win);
  globalThis.window = win as unknown as Window & typeof globalThis;
  globalThis.sessionStorage = sessionStorageMock as unknown as Storage;

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ status: 403, error: 'Access denied' }), { status: 403 });

  const sf = new SecureFlows({
    origin: 'https://www.secure-flows.com',
    appId: 'myapp',
    workspace: 'demo',
  });

  try {
    void sf.login({ redirectUri: 'http://localhost:3000/callback' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(storage.get(keys.tokenKey), undefined);
    assert.ok(assigned.includes('/app/sessions/login'));
  } finally {
    globalThis.fetch = origFetch;
    globalThis.window = previousWindow;
    globalThis.sessionStorage = previousSessionStorage;
  }
});

test('login rethrows billing grace-lock 403 (not signed-out)', async () => {
  const previousWindow = globalThis.window;
  const previousSessionStorage = globalThis.sessionStorage;
  const keys = sessionStorageKeys('myapp', 'demo');
  const storage = new Map<string, string>([[keys.tokenKey, 'live-token']]);
  const sessionStorageMock = {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
    removeItem: (k: string) => storage.delete(k),
  };

  const win = {
    location: {
      href: 'http://localhost:3000/',
      origin: 'http://localhost:3000',
      pathname: '/',
      assign: (_url: string) => {},
    },
    sessionStorage: sessionStorageMock,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  } as {
    location: { href: string; origin: string; pathname: string; assign: (url: string) => void };
    sessionStorage: typeof sessionStorageMock;
    setTimeout: typeof globalThis.setTimeout;
    clearTimeout: typeof globalThis.clearTimeout;
    top: typeof win;
    self: typeof win;
  };
  win.top = win;
  win.self = win;
  attachPageHide(win);
  globalThis.window = win as unknown as Window & typeof globalThis;
  globalThis.sessionStorage = sessionStorageMock as unknown as Storage;

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ status: 403, code: 'BILLING_GRACE_LOCK', error: 'locked' }), {
      status: 403,
    });

  const sf = new SecureFlows({
    origin: 'https://www.secure-flows.com',
    appId: 'myapp',
    workspace: 'demo',
  });

  try {
    await assert.rejects(sf.login({ redirectUri: 'http://localhost:3000/callback' }), (err: unknown) => {
      assert.ok(err instanceof SecureFlowsHttpError);
      assert.equal((err as SecureFlowsHttpError).status, 403);
      return true;
    });
    assert.equal(storage.get(keys.tokenKey), 'live-token');
  } finally {
    globalThis.fetch = origFetch;
    globalThis.window = previousWindow;
    globalThis.sessionStorage = previousSessionStorage;
  }
});

test('login rethrows non-stale fetchSession failures', async () => {
  const previousWindow = globalThis.window;
  const previousSessionStorage = globalThis.sessionStorage;
  const storage = new Map<string, string>([[sessionStorageKeys('myapp').tokenKey, 'live-token']]);
  const sessionStorageMock = {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
    removeItem: (k: string) => storage.delete(k),
  };

  const win = {
    location: {
      href: 'http://localhost:3000/',
      origin: 'http://localhost:3000',
      pathname: '/',
      assign: (_url: string) => {},
    },
    sessionStorage: sessionStorageMock,
    top: null as unknown,
    self: null as unknown,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  };
  win.top = win;
  win.self = win;
  attachPageHide(win);
  globalThis.window = win as unknown as Window & typeof globalThis;
  globalThis.sessionStorage = sessionStorageMock as unknown as Storage;

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('server error', { status: 503 });

  const sf = new SecureFlows({
    origin: 'https://www.secure-flows.com',
    appId: 'myapp',
    workspace: 'demo',
  });

  try {
    await assert.rejects(sf.login({ redirectUri: 'http://localhost:3000/callback' }), (err: unknown) => {
      assert.ok(err instanceof SecureFlowsHttpError);
      assert.equal((err as SecureFlowsHttpError).status, 503);
      return true;
    });
    assert.equal(storage.get(sessionStorageKeys('myapp').tokenKey), 'live-token');
  } finally {
    globalThis.fetch = origFetch;
    globalThis.window = previousWindow;
    globalThis.sessionStorage = previousSessionStorage;
  }
});

test('fetchSession uses Authorization bearer and returns JSON body', async () => {
  const sf = new SecureFlows({
    origin: 'https://api.example.com',
    appId: 'a',
    workspace: 'w',
  });

  const origFetch = globalThis.fetch;
  let seenUrl = '';
  let seenAuth = '';
  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    seenUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    seenAuth = (init?.headers as Record<string, string>)?.Authorization ?? '';
    return new Response(JSON.stringify({ hello: 'world' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const data = await sf.fetchSession('session-jwt');
    assert.deepEqual(data, { hello: 'world' });
    assert.ok(seenUrl.includes('/api/v1/sessions'));
    assert.equal(seenAuth, 'Bearer session-jwt');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('navigateForHostedLogin uses direct assign when not in an iframe', () => {
  const previousWindow = globalThis.window;
  let assigned = '';

  const win = {
    self: null as unknown,
    top: null as unknown,
    location: {
      assign: (url: string) => {
        assigned = url;
      },
    },
  };
  win.self = win;
  win.top = win;
  globalThis.window = win as unknown as Window & typeof globalThis;

  try {
    navigateForHostedLogin('https://www.secure-flows.com/app/sessions/login');
    assert.equal(assigned, 'https://www.secure-flows.com/app/sessions/login');
  } finally {
    globalThis.window = previousWindow;
  }
});

test('navigateForHostedLogin uses same-frame assign first in iframe', () => {
  const previousWindow = globalThis.window;
  let sameFrameUrl = '';
  let topAssignCalled = false;

  const topLike = {
    location: {
      assign: (_url: string) => {
        topAssignCalled = true;
      },
    },
  };

  const win = {
    self: null as unknown,
    top: topLike,
    location: {
      assign: (url: string) => {
        sameFrameUrl = url;
      },
    },
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  };
  win.self = win;
  globalThis.window = win as unknown as Window & typeof globalThis;

  try {
    navigateForHostedLogin('https://www.secure-flows.com/app/sessions/login');
    assert.equal(sameFrameUrl, 'https://www.secure-flows.com/app/sessions/login');
    assert.equal(topAssignCalled, false);
  } finally {
    globalThis.window = previousWindow;
  }
});

test('navigateForHostedLogin falls back to top breakout when same-frame is ignored', async () => {
  const previousWindow = globalThis.window;
  let clicked = false;
  let removed = false;
  let appended = false;
  let sameFrameCalls = 0;

  const anchor = {
    href: '',
    target: '',
    rel: '',
    style: { display: '' },
    click: () => {
      clicked = true;
    },
    remove: () => {
      removed = true;
    },
  };

  const topLike = {};
  Object.defineProperty(topLike, 'location', {
    get() {
      throw new Error('cross-origin');
    },
  });

  const win = {
    self: null as unknown,
    top: topLike,
    location: {
      assign: (_url: string) => {
        sameFrameCalls += 1;
      },
    },
    document: {
      body: {
        appendChild: (_node: unknown) => {
          appended = true;
        },
      },
      createElement: (tag: string) => {
        assert.equal(tag, 'a');
        return anchor;
      },
    },
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  };
  win.self = win;
  globalThis.window = win as unknown as Window & typeof globalThis;

  try {
    navigateForHostedLogin('https://www.secure-flows.com/app/sessions/login');
    assert.equal(sameFrameCalls, 1);
    assert.equal(clicked, false);

    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(appended, true);
    assert.equal(clicked, true);
    assert.equal(removed, true);
    assert.equal(anchor.target, '_top');
  } finally {
    globalThis.window = previousWindow;
  }
});

test('navigateForHostedLogin calls onBlocked when all navigation attempts are ignored', async () => {
  const previousWindow = globalThis.window;
  let clicked = false;
  let blocked = false;
  let sameFrameCalls = 0;

  const anchor = {
    href: '',
    target: '',
    rel: '',
    style: { display: '' },
    click: () => {
      clicked = true;
    },
    remove: () => {},
  };

  const topLike = {
    location: {
      assign: (_url: string) => {},
    },
  };

  const win = {
    self: null as unknown,
    top: topLike,
    location: {
      assign: (_url: string) => {
        sameFrameCalls += 1;
      },
    },
    document: {
      body: {
        appendChild: (_node: unknown) => {},
      },
      createElement: (tag: string) => {
        assert.equal(tag, 'a');
        return anchor;
      },
    },
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  };
  win.self = win;
  attachPageHide(win);
  globalThis.window = win as unknown as Window & typeof globalThis;

  try {
    navigateForHostedLogin('https://www.secure-flows.com/app/sessions/login', () => {
      blocked = true;
    });
    assert.equal(sameFrameCalls, 1);
    assert.equal(clicked, false);
    assert.equal(blocked, false);

    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(clicked, false);

    // Anchor click fires at 200ms; onBlocked at 300ms — keep assertions between those timers.
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(clicked, true);
    assert.equal(blocked, false);

    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(blocked, true);
  } finally {
    globalThis.window = previousWindow;
  }
});

test('login rejects when navigation does not start', async () => {
  const previousWindow = globalThis.window;
  const previousSessionStorage = globalThis.sessionStorage;
  const storage = new Map<string, string>();
  const sessionStorageMock = {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
    removeItem: (k: string) => storage.delete(k),
  };

  const win = {
    location: {
      href: 'http://localhost:3000/',
      origin: 'http://localhost:3000',
      pathname: '/',
      assign: (_url: string) => {
        // Preview sandbox ignores navigation.
      },
    },
    sessionStorage: sessionStorageMock,
    top: null as unknown,
    self: null as unknown,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  };
  win.top = win;
  win.self = win;
  attachPageHide(win);
  globalThis.window = win as unknown as Window & typeof globalThis;
  globalThis.sessionStorage = sessionStorageMock as unknown as Storage;

  const sf = new SecureFlows({
    origin: 'https://www.secure-flows.com',
    appId: 'myapp',
    workspace: 'demo',
  });

  try {
    const loginPromise = sf.login({ redirectUri: 'http://localhost:3000/callback' });
    await assert.rejects(loginPromise, (err: unknown) => {
      assert.ok(err instanceof HostedLoginNavigationError);
      assert.match((err as Error).message, /navigation did not start/i);
      return true;
    });
  } finally {
    globalThis.window = previousWindow;
    globalThis.sessionStorage = previousSessionStorage;
  }
});

test('login rejects quickly when iframe breakout is blocked', async () => {
  const previousWindow = globalThis.window;
  const previousSessionStorage = globalThis.sessionStorage;
  const storage = new Map<string, string>();
  const sessionStorageMock = {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
    removeItem: (k: string) => storage.delete(k),
  };

  const anchor = {
    href: '',
    target: '',
    rel: '',
    style: { display: '' },
    click: () => {},
    remove: () => {},
  };

  const topLike = {
    location: {
      assign: (_url: string) => {},
    },
  };

  const win = {
    self: null as unknown,
    top: topLike,
    location: {
      href: 'http://localhost:3000/',
      origin: 'http://localhost:3000',
      pathname: '/',
      assign: (_url: string) => {
        // Same-frame and breakout attempts ignored by sandbox.
      },
    },
    sessionStorage: sessionStorageMock,
    document: {
      body: { appendChild: (_node: unknown) => {} },
      createElement: (tag: string) => {
        assert.equal(tag, 'a');
        return anchor;
      },
    },
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  };
  win.self = win;
  attachPageHide(win);
  globalThis.window = win as unknown as Window & typeof globalThis;
  globalThis.sessionStorage = sessionStorageMock as unknown as Storage;

  const sf = new SecureFlows({
    origin: 'https://www.secure-flows.com',
    appId: 'myapp',
    workspace: 'demo',
  });

  try {
    const started = Date.now();
    const loginPromise = sf.login({ redirectUri: 'http://localhost:3000/callback' });
    await assert.rejects(loginPromise, (err: unknown) => {
      assert.ok(err instanceof HostedLoginNavigationError);
      assert.match((err as Error).message, /restricted iframe/i);
      return true;
    });
    assert.ok(Date.now() - started < 2000, 'iframe block should fail faster than the full timeout');
  } finally {
    globalThis.window = previousWindow;
    globalThis.sessionStorage = previousSessionStorage;
  }
});

test('login accepts callback sessionToken when CSRF state is absent', async () => {
  const previousWindow = globalThis.window;
  const previousSessionStorage = globalThis.sessionStorage;
  const storage = new Map<string, string>();
  const sessionStorageMock = {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
    removeItem: (k: string) => storage.delete(k),
  };

  const win = {
    location: {
      href: 'http://localhost:3000/callback?sessionToken=callback-token',
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
    sessionStorage: sessionStorageMock,
    top: null as unknown,
    self: null as unknown,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  };
  win.top = win;
  win.self = win;
  globalThis.window = win as unknown as Window & typeof globalThis;
  globalThis.history = win.history as unknown as History;
  globalThis.document = { title: 'callback' } as Document;
  globalThis.sessionStorage = sessionStorageMock as unknown as Storage;

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  const sf = new SecureFlows({
    origin: 'https://www.secure-flows.com',
    appId: 'myapp',
    workspace: 'demo',
  });

  try {
    const session = await sf.login({ redirectUri: 'http://localhost:3000/callback' });
    assert.deepEqual(session, { ok: true });
    assert.equal(storage.get(sessionStorageKeys('myapp', 'demo').tokenKey), 'callback-token');
  } finally {
    globalThis.fetch = origFetch;
    globalThis.window = previousWindow;
    globalThis.sessionStorage = previousSessionStorage;
    delete (globalThis as { history?: History }).history;
    delete (globalThis as { document?: Document }).document;
  }
});

test('ensureSession defaults redirect_uri to /callback', async () => {
  const previousWindow = globalThis.window;
  const previousSessionStorage = globalThis.sessionStorage;
  let assigned = '';
  const storage = new Map<string, string>();
  const sessionStorageMock = {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
    removeItem: (k: string) => storage.delete(k),
  };
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
    sessionStorage: sessionStorageMock,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  } as {
    location: { href: string; origin: string; pathname: string; assign: (url: string) => void };
    sessionStorage: typeof sessionStorageMock;
    setTimeout: typeof globalThis.setTimeout;
    clearTimeout: typeof globalThis.clearTimeout;
    top: typeof win;
    self: typeof win;
  };
  win.top = win;
  win.self = win;
  attachPageHide(win);
  globalThis.window = win as unknown as Window & typeof globalThis;
  globalThis.sessionStorage = sessionStorageMock as unknown as Storage;

  const sf = new SecureFlows({
    origin: 'https://www.secure-flows.com',
    appId: 'myapp',
    workspace: 'demo',
  });

  try {
    void sf.ensureSession();
    assert.ok(assigned.includes('/app/sessions/login'));
    assert.ok(assigned.includes(encodeURIComponent('http://localhost:3000/callback')));
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    globalThis.window = previousWindow;
    globalThis.sessionStorage = previousSessionStorage;
  }
});

test('sessionStorageKeys scopes token and state per appId', () => {
  assert.deepEqual(sessionStorageKeys('myapp'), {
    tokenKey: 'sf.token.myapp',
    stateKey: 'sf.state.myapp',
  });
  assert.throws(() => sessionStorageKeys(''), /appId is required/);
});

test('getToken migrates legacy sf.token once', () => {
  const previousSessionStorage = globalThis.sessionStorage;
  const storage = new Map<string, string>([['sf.token', 'legacy-jwt']]);
  const sessionStorageMock = {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
    removeItem: (k: string) => storage.delete(k),
  };
  globalThis.sessionStorage = sessionStorageMock as unknown as Storage;

  const sf = new SecureFlows({
    origin: 'https://www.secure-flows.com',
    appId: 'myapp',
    workspace: 'demo',
  });

  try {
    assert.equal(sf.getToken(), 'legacy-jwt');
    assert.equal(storage.get(sessionStorageKeys('myapp', 'demo').tokenKey), 'legacy-jwt');
    assert.equal(storage.get('sf.token'), undefined);
  } finally {
    globalThis.sessionStorage = previousSessionStorage;
  }
});

test('getToken does not mix tokens between apps on the same origin', () => {
  const previousSessionStorage = globalThis.sessionStorage;
  const storage = new Map<string, string>([
    [sessionStorageKeys('app-a', 'demo').tokenKey, 'token-a'],
    [sessionStorageKeys('app-b', 'demo').tokenKey, 'token-b'],
  ]);
  const sessionStorageMock = {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
    removeItem: (k: string) => storage.delete(k),
  };
  globalThis.sessionStorage = sessionStorageMock as unknown as Storage;

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
    assert.equal(sfA.getToken(), 'token-a');
    assert.equal(sfB.getToken(), 'token-b');
    sfA.logout();
    assert.equal(sfA.getToken(), null);
    assert.equal(sfB.getToken(), 'token-b');
  } finally {
    globalThis.sessionStorage = previousSessionStorage;
  }
});

test('logoutWithRedirect is a no-op when there is no stored token', async () => {
  const previousWindow = globalThis.window;
  const previousSessionStorage = globalThis.sessionStorage;
  const keys = sessionStorageKeys('myapp', 'demo');
  const storage = new Map<string, string>();
  const sessionStorageMock = {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
    removeItem: (k: string) => storage.delete(k),
  };

  let assigned = '';
  const win = {
    location: {
      href: 'http://localhost:3000/',
      origin: 'http://localhost:3000',
      pathname: '/',
      assign: (url: string) => {
        assigned = url;
      },
    },
    sessionStorage: sessionStorageMock,
  } as {
    location: { href: string; origin: string; pathname: string; assign: (url: string) => void };
    sessionStorage: typeof sessionStorageMock;
    top: unknown;
    self: unknown;
  };
  win.top = win;
  win.self = win;
  globalThis.window = win as unknown as Window & typeof globalThis;
  globalThis.sessionStorage = sessionStorageMock as unknown as Storage;

  const sf = new SecureFlows({
    origin: 'https://www.secure-flows.com',
    appId: 'myapp',
    workspace: 'demo',
  });

  try {
    assert.equal(sf.getToken(), null);
    await sf.logoutWithRedirect({ redirectUri: 'http://localhost:3000/' });
    assert.equal(assigned, '');
    assert.equal(storage.get(keys.tokenKey), undefined);
  } finally {
    globalThis.window = previousWindow;
    globalThis.sessionStorage = previousSessionStorage;
  }
});

test('logoutWithRedirect navigates to logout URL then login starts hosted login (re-login)', async () => {
  const previousWindow = globalThis.window;
  const previousSessionStorage = globalThis.sessionStorage;
  const keys = sessionStorageKeys('myapp', 'demo');
  const storage = new Map<string, string>([[keys.tokenKey, 'pre-logout-jwt']]);
  const sessionStorageMock = {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => storage.set(k, v),
    removeItem: (k: string) => storage.delete(k),
  };

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
    sessionStorage: sessionStorageMock,
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
  } as {
    location: { href: string; origin: string; pathname: string; assign: (url: string) => void };
    sessionStorage: typeof sessionStorageMock;
    setTimeout: typeof globalThis.setTimeout;
    clearTimeout: typeof globalThis.clearTimeout;
    top: typeof win;
    self: typeof win;
  };
  win.top = win;
  win.self = win;
  attachPageHide(win);
  globalThis.window = win as unknown as Window & typeof globalThis;
  globalThis.sessionStorage = sessionStorageMock as unknown as Storage;

  const sf = new SecureFlows({
    origin: 'https://www.secure-flows.com',
    appId: 'myapp',
    workspace: 'demo',
  });

  try {
    await sf.logoutWithRedirect({ redirectUri: 'http://localhost:3000/' });
    assert.equal(storage.get(keys.tokenKey), undefined);
    assert.ok(assigned.includes('/api/v1/auth/logout'));
    assert.ok(assigned.includes(encodeURIComponent('pre-logout-jwt')));
    assert.ok(assigned.includes(encodeURIComponent('http://localhost:3000/')));
    assert.ok(!assigned.toLowerCase().includes('session_token=' + encodeURIComponent('http')));

    // Simulate post-logout landing with no token — login must start hosted login (re-login).
    assigned = '';
    void sf.login({ redirectUri: 'http://localhost:3000/callback' });
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(assigned.includes('/app/sessions/login'));
    assert.ok(assigned.includes(encodeURIComponent('http://localhost:3000/callback')));
  } finally {
    globalThis.window = previousWindow;
    globalThis.sessionStorage = previousSessionStorage;
  }
});
