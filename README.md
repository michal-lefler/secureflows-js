# secureflows-js

[![secureFlows](https://img.shields.io/badge/secureFlows-www.secure--flows.com-1a73e8)](https://www.secure-flows.com)

Minimal browser JS/TS SDK for [secureFlows](https://www.secure-flows.com) **hosted session login**
and Session API reads.

> This repo is a public mirror, published periodically from the private secureFlows monorepo
> where development actually happens. Issues and PRs are welcome; large changes may take a
> release cycle to land upstream first.

## Install

```bash
npm install secureflows-js
```

## Quick start (stable hosted login)

Copy `templates/web-app-secureflows/` from the secureFlows repo.

```ts
import { SecureFlows } from "secureflows-js";

const sf = new SecureFlows({
  origin: "https://www.secure-flows.com",
  appId: "acme-web",
  workspace: "my-workspace",
});

const APP_ORIGIN = "https://your-app-host";
const redirectUri = `${APP_ORIGIN}/callback`;

// App load: restore session payload and signed-in email for the header.
export async function restoreSession() {
  const token = sf.getToken();
  if (!token) return null;
  const [session, identity] = await Promise.all([
    sf.fetchSession(token),
    sf.fetchSessionIdentity(token),
  ]);
  return { session, email: identity.email };
}

// Sign-in CTA: start hosted login from one explicit user action.
export async function signIn() {
  await sf.login({ redirectUri });
}

// /callback route: complete the return and go home.
export async function completeCallback() {
  await sf.ensureSession({ redirectUri });
  window.location.replace("/");
}
```

Register `https://YOUR_HOST/callback` in the workspace dashboard. Requires `secureflows-js` ≥ 0.1.13 (≥ 0.1.15 for `identity.userId`).

After sign-in, call `sf.fetchSessionIdentity(token)` to show the user's email in the app header (next to Sign out). The same call also returns `identity.userId` — a stable, opaque id for this person across sessions/logins. If your own backend needs to link an external event (e.g. a billing provider webhook it receives and verifies itself) back to this user, pass `userId` through, not the session token — that expires and rotates, `userId` doesn't.

`sf.login()` and `logoutWithRedirect()` use the SDK's navigation helper internally. In preview
iframes the SDK tries **same-frame** navigation first (proven on Base44), then top-level breakout
if navigation does not start. If all attempts are blocked, `sf.login()` rejects with
`HostedLoginNavigationError` instead of hanging.

If a stored token is expired after long idle, restore treats `401`/`410` (and legacy JSON
`403` Access denied) as signed-out via `isSessionSignedOutError` — clears the token and
shows **Continue with secureFlows** (or `login()` falls through to hosted login) instead of
leaving the caller stuck retrying the same token. Requires `secureflows-js` ≥ **0.1.14**.

`logout()` only clears `sessionStorage`. If your app keeps React (or other) session state,
clear that too on signed-out — or use a provider `handleSignedOut()` that does both. Otherwise
`logoutWithRedirect()` no-ops (no token) while the signed-in shell remains. See
[platform-hosted-apps.md](https://www.secure-flows.com/docs/integration/platform-hosted-apps.md)
and the React starter under `templates/web-app-secureflows/`.

App code should call those methods directly instead of manually using `navigateForHostedLogin()`.

## Token storage (multiple apps, same origin)

The SDK stores tokens in `sessionStorage` under **`sf.token.v2.<workspace>.<appId>`** (and login state under `sf.state.v2.<workspace>.<appId>`). This prevents two secureFlows-integrated apps on the same host (e.g. localhost or a shared preview origin) from overwriting each other's session tokens — even when the same `appId` exists in multiple workspaces.

Hand-rolled integrations: import `sessionStorageKeys(appId, workspace)` (recommended) or use the same v2 key format.

Backward compatibility:
- Legacy `sf.token` (pre-0.1.11) is migrated once on read when the scoped key is empty.
- Previous per-app keys (`sf.token.<appId>`) are migrated into v2 keys without deleting the old key (it is ambiguous across workspaces).

## Integration reference

- [SKILL.md](https://www.secure-flows.com/ai/secureflows-integration/SKILL.md)
- [Session API](https://www.secure-flows.com/docs/openapi/session/secure-flows-session-api.html) — includes `GET /sessions/identity`
- [platform-hosted-apps.md](https://www.secure-flows.com/docs/integration/platform-hosted-apps.md)

## Development

```bash
cd secureflows-js && npm install && npm test && npm run build
```

## License

MIT
