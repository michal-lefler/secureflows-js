export type SessionJson = Record<string, unknown>;

export type SessionIdentity = {
  /** Stable, opaque id for this person across sessions/logins — correlate external events (e.g. billing webhooks handled by your own backend) to this user. Not a Firebase UID. */
  userId: number | null;
  email: string | null;
};

export type SecureFlowsOptions = {
  origin: string;
  appId: string;
  workspace: string;
  ttlSeconds?: number;
  payload?: Record<string, unknown>;
};

export type SecureFlowsLoginOptions = {
  ttlSeconds?: number;
  payload?: Record<string, unknown>;
  /** Allowlisted callback URL; defaults to {@link defaultCallbackRedirectUri}. */
  redirectUri?: string;
};

const LEGACY_STATE_KEY = "sf.state";
const LEGACY_TOKEN_KEY = "sf.token";

function encodeKeyPart(raw: string): string {
  // encodeURIComponent is stable and avoids collisions with separators ('.')
  return encodeURIComponent(raw.trim());
}

/**
 * sessionStorage keys scoped per registered application and workspace.
 *
 * Backward compatible:
 * - When `workspace` is omitted, returns the legacy per-app keys (`sf.token.<appId>`, `sf.state.<appId>`).
 * - When `workspace` is provided, returns v2 keys that include both parts.
 */
export function sessionStorageKeys(appId: string, workspace?: string): { tokenKey: string; stateKey: string } {
  const id = appId.trim();
  if (!id) {
    throw new Error("appId is required for sessionStorage keys");
  }

  const ws = workspace?.trim() ?? "";
  if (!ws) {
    return {
      tokenKey: `sf.token.${id}`,
      stateKey: `sf.state.${id}`,
    };
  }

  const w = encodeKeyPart(ws);
  const a = encodeKeyPart(id);
  return {
    tokenKey: `sf.token.v2.${w}.${a}`,
    stateKey: `sf.state.v2.${w}.${a}`,
  };
}

/** Wait after a top-level navigation attempt before trying the next fallback. */
const NAVIGATION_VERIFY_MS = 100;

/** Fail {@link SecureFlows.login} / {@link SecureFlows.logoutWithRedirect} when no navigation starts (silent sandbox block). */
const NAVIGATION_TIMEOUT_MS = 2000;

export class HostedLoginNavigationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostedLoginNavigationError";
  }
}

/**
 * Thrown by {@link SecureFlows.fetchSession} for any non-2xx response, carrying the
 * HTTP status so callers (notably {@link SecureFlows.login}) can distinguish an
 * expired/invalid token (401/410 — recoverable by re-authenticating) from other
 * failures (network errors, 5xx, malformed responses — not safe to silently retry).
 */
export class SecureFlowsHttpError extends Error {
  readonly status: number;
  /** Raw response body (may be empty). */
  readonly body: string;

  constructor(status: number, message: string, body = "") {
    super(message);
    this.name = "SecureFlowsHttpError";
    this.status = status;
    this.body = body;
  }
}

/**
 * Session API auth failure that means “clear token and show login/CTA”.
 *
 * Includes legacy JSON `403` `Access denied` (expired JWT used to clear the security
 * context and fall through as anonymous). Does **not** treat billing
 * `BILLING_GRACE_LOCK` as signed-out.
 */
export function isSessionSignedOutError(err: SecureFlowsHttpError): boolean {
  return isSessionSignedOutStatus(err.status, err.body);
}

export function isSessionSignedOutStatus(status: number, body = ""): boolean {
  if (status === 401 || status === 410) return true;
  if (status !== 403) return false;
  const text = body.trim();
  if (!text) return true;
  try {
    const parsed = JSON.parse(text) as { code?: unknown; error?: unknown };
    if (parsed?.code === "BILLING_GRACE_LOCK") return false;
    if (parsed?.error === "Access denied") return true;
  } catch {
    // non-JSON body
  }
  return false;
}

function isStaleTokenError(err: unknown): boolean {
  return err instanceof SecureFlowsHttpError && isSessionSignedOutError(err);
}

function isInIframe(): boolean {
  try {
    return window.top != null && window.top !== window.self;
  } catch {
    return true;
  }
}

/**
 * Waits for positive evidence that a top-level navigation away from this document has
 * actually begun. `pagehide` fires only on a real unload — including when the *parent*
 * frame navigates away and tears this iframe down with it — so, unlike checking
 * `document.visibilityState`, it is not confused by the user merely switching tabs.
 *
 * Resolves once navigation starts; rejects with {@link HostedLoginNavigationError} if
 * nothing happens within `timeoutMs`, or immediately if `onBlocked` fires first.
 */
function awaitNavigationOutcome(
  startNavigation: (onBlocked: () => void) => void,
  timeoutMs: number,
  blockedMessage: string,
  timeoutMessage: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const onPageHide = () => succeed();
    window.addEventListener("pagehide", onPageHide, { once: true });

    function cleanup(): void {
      window.removeEventListener("pagehide", onPageHide);
    }

    function succeed(): void {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    }

    function fail(message: string): void {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new HostedLoginNavigationError(message));
    }

    startNavigation(() => fail(blockedMessage));

    window.setTimeout(() => fail(timeoutMessage), timeoutMs);
  });
}

/**
 * Full-page navigation to hosted login/logout.
 *
 * **Top-level pages:** assign in the current window.
 *
 * **Preview iframes (Base44, Lovable, etc.):** assign in the **current frame first** — the iframe
 * document navigates to hosted login and back to `/callback` without needing top-level sandbox
 * permissions. This matches proven platform-hosted integrations that use `window.location.href`.
 *
 * If same-frame navigation does not start within {@link NAVIGATION_VERIFY_MS}, fall back to
 * top-level breakout (`window.top` → anchor `target=_top`). If that is also blocked, call
 * `onBlocked` so the caller can surface an actionable error.
 *
 * @internal Application code must not call this — use {@link SecureFlows.login} or
 * {@link SecureFlows.logoutWithRedirect}, which apply this navigation strategy (and its
 * iframe/preview fallbacks) for you. Exported only for the SDK's own tests.
 */
export function navigateForHostedLogin(url: string, onBlocked?: () => void): void {
  if (typeof window === "undefined") return;

  const assignSameFrame = (): void => {
    window.location.assign(url);
  };

  if (!isInIframe()) {
    assignSameFrame();
    return;
  }

  const reportBlocked = (): void => {
    if (onBlocked) {
      onBlocked();
      return;
    }
    console.warn(
      "[secureflows-js] Hosted login/logout navigation did not start, and no failure handler was provided.",
    );
  };

  const tryAnchorTopNavigation = (): void => {
    try {
      const anchor = window.document?.createElement?.("a");
      if (!anchor) {
        reportBlocked();
        return;
      }
      anchor.href = url;
      anchor.target = "_top";
      anchor.rel = "noopener noreferrer";
      anchor.style.display = "none";
      window.document.body?.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(reportBlocked, NAVIGATION_VERIFY_MS);
    } catch {
      reportBlocked();
    }
  };

  const tryTopBreakout = (): void => {
    try {
      const top = window.top;
      if (top != null && top !== window.self) {
        top.location.assign(url);
        window.setTimeout(tryAnchorTopNavigation, NAVIGATION_VERIFY_MS);
        return;
      }
    } catch {
      // Some sandboxed or cross-origin previews block direct access to window.top.location.
    }

    tryAnchorTopNavigation();
  };

  try {
    assignSameFrame();
  } catch {
    tryTopBreakout();
    return;
  }

  window.setTimeout(tryTopBreakout, NAVIGATION_VERIFY_MS);
}

export class SecureFlows {
  private readonly origin: URL;
  private readonly appId: string;
  private readonly workspace: string;
  private readonly ttlSeconds?: number;
  private readonly payload?: Record<string, unknown>;

  constructor({ origin, appId, workspace, ttlSeconds, payload }: SecureFlowsOptions) {
    if (!origin || !appId || !workspace) {
      throw new Error("SecureFlows requires origin, appId, workspace");
    }
    this.origin = new URL(origin);
    this.appId = appId;
    this.workspace = workspace;
    this.ttlSeconds = ttlSeconds;
    this.payload = payload;
  }

  private storageKeys() {
    return sessionStorageKeys(this.appId, this.workspace);
  }

  getToken(): string | null {
    try {
      const { tokenKey } = this.storageKeys();
      const token = sessionStorage.getItem(tokenKey);
      if (token) {
        return token;
      }

      // Backward compat (0.1.11–0.1.12): per-app key without workspace scoping.
      const prevScoped = sessionStorage.getItem(sessionStorageKeys(this.appId).tokenKey);
      if (prevScoped) {
        sessionStorage.setItem(tokenKey, prevScoped);
        // Do not remove the previous key: it is ambiguous across workspaces on the same origin.
        return prevScoped;
      }

      // Legacy (pre-0.1.11): single global key.
      const legacy = sessionStorage.getItem(LEGACY_TOKEN_KEY);
      if (legacy) {
        sessionStorage.setItem(tokenKey, legacy);
        sessionStorage.removeItem(LEGACY_TOKEN_KEY);
        return legacy;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Clears the in-app session token from `sessionStorage` only (no hosted logout redirect).
   * Callers that keep React/`session` (or equivalent) auth UI state must also clear that state
   * so the Continue CTA returns — otherwise Sign out via {@link logoutWithRedirect} no-ops
   * (no token) while the signed-in shell remains. Prefer a provider `handleSignedOut()` that
   * does both.
   */
  logout(): void {
    try {
      const { tokenKey, stateKey } = this.storageKeys();
      sessionStorage.removeItem(stateKey);
      sessionStorage.removeItem(tokenKey);
    } catch {
      // ignore
    }
  }

  /**
   * Browser-safe logout.
   *
   * For web apps running cross-origin (including localhost), cookie clearing is only reliable when logout is
   * performed as a top-level navigation on `secure-flows.com` (first-party context). This method:
   *
   * 1) Navigates the browser to `GET /api/v1/auth/logout?session_token=...&redirect_uri=...`
   * 2) Clears in-app token state (sessionStorage) once that navigation is confirmed underway
   *    — immediately for the common non-iframe case (synchronous and reliable), or once a
   *    real navigation start is observed when running inside an iframe.
   *
   * Local token state is deliberately left untouched if the navigation cannot be confirmed —
   * clearing it first would make the app look signed out locally while the server-side
   * session and hosted-login cookie were never actually asked to log out.
   *
   * Notes:
   * - `redirectUri` MUST be allowlisted for your app in the secureFlows dashboard.
   * - Never include `session_token` inside the post-logout `redirect_uri` (would silently renew).
   * - Rejects with {@link HostedLoginNavigationError} if the redirect could not proceed
   *   (e.g. blocked inside a restricted preview iframe).
   */
  async logoutWithRedirect(opts: { redirectUri?: string } = {}): Promise<void> {
    const token = this.getToken();
    if (!token) return;

    const redirectUri = opts.redirectUri ?? currentRedirectUri();
    const u = this.buildLogoutRedirectUrl({ sessionToken: token, redirectUri });

    if (typeof window === "undefined") return;

    if (!isInIframe()) {
      this.logout();
      navigateForHostedLogin(u.toString());
      return;
    }

    await awaitNavigationOutcome(
      (onBlocked) => navigateForHostedLogin(u.toString(), onBlocked),
      NAVIGATION_TIMEOUT_MS,
      "Sign-out could not open — this preview appears to be inside a restricted iframe. Open the published app in a new tab to sign out.",
      "Sign-out navigation did not start. If you are in a preview iframe, open the published app in a new tab and try again.",
    );
    this.logout();
  }

  /**
   * @internal Use {@link SecureFlows.logoutWithRedirect} instead. Building this URL by hand
   * invites the two documented sign-out failures: passing a token read from React/context state
   * (stale or already-cleared → the navigation signs out nothing), and a `redirect_uri` that
   * points at `/callback` or carries `session_token` (→ silent re-auth, so sign-out appears not
   * to work).
   */
  buildLogoutRedirectUrl(args: { sessionToken: string; redirectUri: string }): URL {
    const u = new URL("/api/v1/auth/logout", this.origin);
    u.searchParams.set("session_token", args.sessionToken);
    u.searchParams.set("redirect_uri", args.redirectUri);
    return u;
  }

  /**
   * Hosted login + session retrieval.
   *
   * - If redirected back with `sessionToken`, validates state, cleans URL, stores token, fetches session JSON.
   * - If a token is already stored, tries to reuse it. If that token turns out to be
   *   expired or invalid (`401`/`410`, empty-body `403`, or legacy JSON `403` Access denied),
   *   the stale token is cleared and this falls through to a fresh hosted-login redirect
   *   below — it does **not** rethrow and leave the caller stuck retrying against the same
   *   dead token. Billing `403` (`BILLING_GRACE_LOCK`) and other failures (network/5xx) are
   *   rethrown as-is.
   * - Otherwise redirects to `{origin}/app/sessions/login?...`. Rejects with
   *   {@link HostedLoginNavigationError} if that navigation cannot be confirmed to have
   *   started (e.g. blocked inside a restricted preview iframe) instead of hanging forever.
   */
  async login(opts: SecureFlowsLoginOptions = {}): Promise<SessionJson> {
    const extracted = this.extractTokenFromUrl(window.location.href);

    if (extracted.error) {
      this.cleanUrl();
      const desc = extracted.errorDescription
        ? ` — ${decodeErrorDescription(extracted.errorDescription)}`
        : "";
      throw new Error(`Hosted login error: ${extracted.error}${desc}`);
    }

    if (extracted.sessionToken) {
      this.validateState(extracted.state);
      this.storeToken(extracted.sessionToken);
      this.cleanUrl();
      return await this.fetchSession(extracted.sessionToken);
    }

    const firebaseToken = this.extractFirebaseTokenFromUrl(window.location.href);
    if (firebaseToken) {
      // Legacy `/app/login` delivers `firebaseToken` to the client callback. Complete the
      // server-side session exchange instead of restarting hosted login (infinite loop).
      this.validateState(extracted.state);
      const redirectUri = opts.redirectUri ?? currentRedirectUri();
      const exchangeUrl = this.buildSessionAuthCallbackUrl({
        firebaseToken,
        clientRedirectUri: redirectUri,
        state: extracted.state,
        sessionTokenParam: this.extractSessionTokenParamFromUrl(window.location.href),
      });
      window.location.assign(exchangeUrl.toString());
      return new Promise<SessionJson>(() => {});
    }

    const existingToken = this.getToken();
    if (existingToken) {
      try {
        return await this.fetchSession(existingToken);
      } catch (err) {
        if (isStaleTokenError(err)) {
          // Token expired/invalid — the session and its data are NOT lost (410 ≠ data
          // loss). Clear the dead token and fall through to build a fresh hosted-login
          // redirect below, instead of rethrowing and leaving the caller stuck retrying
          // against the same token forever.
          this.logout();
        } else {
          throw err;
        }
      }
    }

    const state = generateState();
    this.storeState(state);

    const ttlSeconds = opts.ttlSeconds ?? this.ttlSeconds;
    const payload = opts.payload ?? this.payload;

    const loginUrl = this.buildLoginUrl({
      appId: this.appId,
      workspace: this.workspace,
      redirectUri: opts.redirectUri ?? currentRedirectUri(),
      state,
      ttlSeconds,
      payload,
    });

    await awaitNavigationOutcome(
      (onBlocked) => navigateForHostedLogin(loginUrl.toString(), onBlocked),
      NAVIGATION_TIMEOUT_MS,
      "Hosted login could not open — this preview appears to be inside a restricted iframe. Open the published app in a new tab and try again.",
      "Hosted login navigation did not start. If you are in a preview iframe, open the published app in a new tab and try again.",
    );

    // Navigation is genuinely underway; this document is about to be torn down.
    // Never resolves — the app resumes via the redirect back to `redirectUri`.
    return new Promise<SessionJson>(() => {});
  }

  /**
   * Cold-start helper: parse callback URL, reuse stored token, or redirect to hosted login.
   *
   * Default {@code redirectUri} is {@code ${origin}/callback}. Copy {@code templates/web-app-secureflows/}.
   */
  async ensureSession(opts: SecureFlowsLoginOptions = {}): Promise<SessionJson> {
    if (typeof window === "undefined") {
      throw new Error("ensureSession requires a browser");
    }
    const redirectUri = opts.redirectUri ?? defaultCallbackRedirectUri();
    return await this.login({ ...opts, redirectUri });
  }

  /**
   * @internal Use {@link SecureFlows.login} instead — it builds this URL and performs the
   * navigation. Hand-building the hosted-login URL is the single largest source of login loops
   * (wrong entry path, missing/incorrect `redirect_uri`, a dead token replayed as `session_token`).
   */
  buildLoginUrl(args: {
    appId: string;
    workspace: string;
    redirectUri: string;
    state: string;
    ttlSeconds?: number;
    payload?: Record<string, unknown>;
  }): URL {
    const u = new URL("/app/sessions/login", this.origin);
    u.searchParams.set("app_id", args.appId);
    u.searchParams.set("workspace_name", args.workspace);
    u.searchParams.set("redirect_uri", args.redirectUri);
    u.searchParams.set("state", args.state);
    if (args.ttlSeconds != null) {
      u.searchParams.set("ttl_seconds", args.ttlSeconds.toString());
    }
    if (args.payload != null) {
      u.searchParams.set("payload", JSON.stringify(args.payload));
    }
    return u;
  }

  extractTokenFromUrl(url: string): {
    sessionToken: string | null;
    state: string | null;
    error: string | null;
    errorDescription: string | null;
  } {
    const u = new URL(url);
    return {
      sessionToken: u.searchParams.get("sessionToken"),
      state: u.searchParams.get("state"),
      error: u.searchParams.get("error"),
      errorDescription: u.searchParams.get("error_description"),
    };
  }

  /**
   * @internal Legacy `/app/login` return leg. {@link SecureFlows.login} handles this exchange
   * internally; application code should never read `firebaseToken` off the URL itself — the only
   * token an app ever handles is `sessionToken`.
   */
  extractFirebaseTokenFromUrl(url: string): string | null {
    return new URL(url).searchParams.get("firebaseToken");
  }

  /** @internal See {@link SecureFlows.extractFirebaseTokenFromUrl}. */
  extractSessionTokenParamFromUrl(url: string): string | null {
    return new URL(url).searchParams.get("session_token");
  }

  /**
   * Server-side session exchange after legacy `/app/login` returns `firebaseToken` to the client.
   *
   * @internal Performed inside {@link SecureFlows.login}; not part of the app-facing API.
   */
  buildSessionAuthCallbackUrl(args: {
    firebaseToken: string;
    clientRedirectUri: string;
    state: string | null;
    sessionTokenParam?: string | null;
  }): URL {
    const u = new URL("/api/v1/auth/callback", this.origin);
    u.searchParams.set("firebaseToken", args.firebaseToken);
    u.searchParams.set("client_redirect_uri", args.clientRedirectUri);
    u.searchParams.set("workspace_name", this.workspace);
    u.searchParams.set("app_id", this.appId);
    if (args.state) {
      u.searchParams.set("state", args.state);
    }
    if (args.sessionTokenParam) {
      u.searchParams.set("session_token", args.sessionTokenParam);
    }
    return u;
  }

  async fetchSession(sessionToken: string): Promise<SessionJson> {
    const u = new URL("/api/v1/sessions", this.origin);
    const res = await fetch(u.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${sessionToken}` },
    });
    const text = await res.text();
    if (!res.ok) {
      throw new SecureFlowsHttpError(
        res.status,
        `GET /api/v1/sessions failed (${res.status}): ${text}`,
        text,
      );
    }
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Unexpected session response shape");
    }
    return parsed as SessionJson;
  }

  /** Signed-in user email for app UI (e.g. header next to Sign out). */
  async fetchSessionIdentity(sessionToken: string): Promise<SessionIdentity> {
    const u = new URL("/api/v1/sessions/identity", this.origin);
    const res = await fetch(u.toString(), {
      method: "GET",
      headers: { Authorization: `Bearer ${sessionToken}` },
    });
    const text = await res.text();
    if (!res.ok) {
      throw new SecureFlowsHttpError(
        res.status,
        `GET /api/v1/sessions/identity failed (${res.status}): ${text}`,
        text,
      );
    }
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Unexpected session identity response shape");
    }
    const email = (parsed as { email?: unknown }).email;
    const userId = (parsed as { userId?: unknown }).userId;
    return {
      userId: typeof userId === "number" ? userId : null,
      email: typeof email === "string" && email.trim() !== "" ? email.trim() : null,
    };
  }

  private storeState(state: string) {
    sessionStorage.setItem(this.storageKeys().stateKey, state);
  }

  private validateState(returnedState: string | null) {
    const expected = sessionStorage.getItem(this.storageKeys().stateKey) || "";
    if (!expected) {
      // Plain platform-hosted callbacks may omit CSRF state; also tolerate a lost storage
      // partition when the server did not round-trip state either.
      if (!returnedState) {
        return;
      }
      throw new Error("Missing expected state in sessionStorage");
    }
    if (!returnedState) {
      throw new Error("Missing state in redirect URL");
    }
    if (returnedState !== expected) {
      throw new Error("State mismatch (possible CSRF)");
    }
  }

  private storeToken(token: string) {
    sessionStorage.setItem(this.storageKeys().tokenKey, token);
  }

  private cleanUrl() {
    const u = new URL(window.location.href);
    u.searchParams.delete("sessionToken");
    u.searchParams.delete("firebaseToken");
    u.searchParams.delete("session_token");
    u.searchParams.delete("state");
    u.searchParams.delete("error");
    u.searchParams.delete("error_description");
    history.replaceState({}, document.title, u.toString());
  }
}

function currentRedirectUri(): string {
  return `${window.location.origin}${window.location.pathname}`;
}

/** Default allowlisted callback for {@link SecureFlows.ensureSession}. */
export function defaultCallbackRedirectUri(): string {
  if (typeof window === "undefined") {
    return "http://localhost/callback";
  }
  return `${window.location.origin}/callback`;
}

function generateState(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function decodeErrorDescription(raw: string): string {
  try {
    return decodeURIComponent(raw.replace(/\+/g, " "));
  } catch {
    return raw;
  }
}