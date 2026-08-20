// Public API. Everything here is safe to call from application code.
//
// `navigateForHostedLogin` was removed from this list in 0.2.0: SKILL.md always described it as
// internal ("generated app code must not call it directly"), but exporting it here made it
// equally discoverable as the correct path, so agents reached for it and hand-rolled navigation
// that the SDK already does correctly. It still exists on the module for the SDK's own tests —
// it is simply no longer part of the package's advertised surface. Use `SecureFlows.login()` /
// `SecureFlows.logoutWithRedirect()`, which apply it (and its iframe fallbacks) for you.
export {
  HostedLoginNavigationError,
  SecureFlows,
  SecureFlowsHttpError,
  defaultCallbackRedirectUri,
  isSessionSignedOutError,
  isSessionSignedOutStatus,
  sessionStorageKeys,
} from "./secureFlows.js";
export type { SecureFlowsLoginOptions, SecureFlowsOptions, SessionIdentity, SessionJson } from "./secureFlows.js";
