import test from 'node:test';
import assert from 'node:assert/strict';

import { SecureFlows, SecureFlowsHttpError } from '../src/secureFlows.js';

test('fetchSessionIdentity returns trimmed email', async () => {
  const sf = new SecureFlows({
    origin: 'https://www.secure-flows.com',
    appId: 'myapp',
    workspace: 'demo',
  });

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    assert.equal(String(input), 'https://www.secure-flows.com/api/v1/sessions/identity');
    return new Response(JSON.stringify({ userId: 42, email: '  ada@example.com  ' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const identity = await sf.fetchSessionIdentity('jwt-token');
    assert.deepEqual(identity, { userId: 42, email: 'ada@example.com' });
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('fetchSessionIdentity returns null userId when absent', async () => {
  const sf = new SecureFlows({
    origin: 'https://www.secure-flows.com',
    appId: 'myapp',
    workspace: 'demo',
  });

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ email: 'a@b.com' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  try {
    const identity = await sf.fetchSessionIdentity('jwt-token');
    assert.deepEqual(identity, { userId: null, email: 'a@b.com' });
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('fetchSessionIdentity returns null when email absent', async () => {
  const sf = new SecureFlows({
    origin: 'https://www.secure-flows.com',
    appId: 'myapp',
    workspace: 'demo',
  });

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ email: null }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  try {
    const identity = await sf.fetchSessionIdentity('jwt-token');
    assert.deepEqual(identity, { userId: null, email: null });
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('fetchSessionIdentity sends Authorization bearer header', async () => {
  const sf = new SecureFlows({
    origin: 'https://www.secure-flows.com',
    appId: 'myapp',
    workspace: 'demo',
  });

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (_input, init) => {
    assert.equal((init?.headers as Record<string, string>).Authorization, 'Bearer my-jwt');
    return new Response(JSON.stringify({ email: 'a@b.com' }), { status: 200 });
  };

  try {
    await sf.fetchSessionIdentity('my-jwt');
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('fetchSessionIdentity treats blank email as null', async () => {
  const sf = new SecureFlows({
    origin: 'https://www.secure-flows.com',
    appId: 'myapp',
    workspace: 'demo',
  });

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ email: '   ' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  try {
    const identity = await sf.fetchSessionIdentity('jwt-token');
    assert.deepEqual(identity, { userId: null, email: null });
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('fetchSessionIdentity throws SecureFlowsHttpError on 401', async () => {
  const sf = new SecureFlows({
    origin: 'https://www.secure-flows.com',
    appId: 'myapp',
    workspace: 'demo',
  });

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ status: 401, error: 'Unauthorized' }), { status: 401 });

  try {
    await assert.rejects(
      () => sf.fetchSessionIdentity('dead-jwt'),
      (err: unknown) => {
        assert.ok(err instanceof SecureFlowsHttpError);
        assert.equal(err.status, 401);
        return true;
      },
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test('fetchSessionIdentity throws SecureFlowsHttpError on 410', async () => {
  const sf = new SecureFlows({
    origin: 'https://www.secure-flows.com',
    appId: 'myapp',
    workspace: 'demo',
  });

  const origFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ status: 410, error: 'Session expired' }), { status: 410 });

  try {
    await assert.rejects(
      () => sf.fetchSessionIdentity('expired-jwt'),
      (err: unknown) => {
        assert.ok(err instanceof SecureFlowsHttpError);
        assert.equal(err.status, 410);
        return true;
      },
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});
