(function () {
  const APP_BASE_URL = "https://www.everydaylilly.com";
  const LOCAL_BASE_URL = "http://localhost:8000";
  const SESSION_KEY = "everydayLillyAuth:session";
  const PENDING_KEY = "everydayLillyAuth:pending";
  const POPUP_PENDING_KEY = "everydayLillyAuth:pendingPopup";
  const POPUP_MESSAGE_TYPE = "everydayLillyAuth:popupResult";
  const POPUP_NAME = "everydayLillyAuthPopup";
  const EXPIRY_SKEW_MS = 60 * 1000;
  const PKCE_CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";

  function getAppBaseUrl() {
    const { hostname, port } = window.location;

    if ((hostname === "localhost" || hostname === "127.0.0.1") && port === "8000") {
      return LOCAL_BASE_URL;
    }

    return APP_BASE_URL;
  }

  function getConfig(overrides = {}) {
    const data = document.body?.dataset ?? {};
    const appBaseUrl = getAppBaseUrl();

    return {
      appBaseUrl,
      baseUrl: overrides.baseUrl || data.authBaseUrl || "",
      clientId: overrides.clientId || data.authClientId || "",
      redirectUri:
        overrides.redirectUri ||
        data.authRedirectUri ||
        `${appBaseUrl}/auth/callback.html`,
      logoutUri:
        overrides.logoutUri ||
        data.authLogoutUri ||
        `${appBaseUrl}/`,
      scope:
        overrides.scope ||
        data.authScope ||
        "openid email profile aws.cognito.signin.user.admin",
    };
  }

  function getStoragePayload(storage, key) {
    try {
      const raw = storage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      return null;
    }
  }

  function setStoragePayload(storage, key, value) {
    storage.setItem(key, JSON.stringify(value));
  }

  function clearPendingState() {
    sessionStorage.removeItem(PENDING_KEY);
    localStorage.removeItem(POPUP_PENDING_KEY);
  }

  function getPendingState() {
    return getStoragePayload(sessionStorage, PENDING_KEY);
  }

  function getPopupPendingState() {
    return getStoragePayload(localStorage, POPUP_PENDING_KEY);
  }

  function getMatchingPendingState(expectedState) {
    const directPending = getPendingState();
    const popupPending = getPopupPendingState();

    if (popupPending?.state === expectedState) {
      return { pending: popupPending, kind: "popup" };
    }

    if (directPending?.state === expectedState) {
      return { pending: directPending, kind: "direct" };
    }

    return null;
  }

  function clearStoredPending(kind) {
    if (kind === "popup") {
      localStorage.removeItem(POPUP_PENDING_KEY);
      return;
    }

    sessionStorage.removeItem(PENDING_KEY);
  }

  function clearSession() {
    try {
      Object.keys(localStorage).filter(key => key.startsWith("everyday-lilly.gallery-manifest.") || key.startsWith("everyday-lilly.gallery-refresh."))
        .forEach(key => localStorage.removeItem(key));
    } catch (error) {}
    sessionStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(SESSION_KEY);
  }

  function getStoredSession() {
    return (
      getStoragePayload(localStorage, SESSION_KEY) ||
      getStoragePayload(sessionStorage, SESSION_KEY)
    );
  }

  function isRememberedSession() {
    return Boolean(localStorage.getItem(SESSION_KEY));
  }

  function saveSession(session, remember) {
    clearSession();
    const storage = remember ? localStorage : sessionStorage;
    setStoragePayload(storage, SESSION_KEY, session);
  }

  function completePopupLogin(payload) {
    if (!payload?.session) {
      throw new Error("Missing popup session payload.");
    }

    saveSession(payload.session, Boolean(payload.remember));
    localStorage.removeItem(POPUP_PENDING_KEY);
    return payload.session;
  }

  function generateRandomString(length) {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);

    let result = "";
    for (let index = 0; index < bytes.length; index += 1) {
      result += PKCE_CHARSET[bytes[index] % PKCE_CHARSET.length];
    }

    return result;
  }

  function toBase64Url(uint8Array) {
    const binary = String.fromCharCode(...uint8Array);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  async function createCodeChallenge(verifier) {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(verifier)
    );

    return toBase64Url(new Uint8Array(digest));
  }

  function decodeJwt(token) {
    const parts = token.split(".");

    if (parts.length < 2) {
      return null;
    }

    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");

    try {
      return JSON.parse(atob(padded));
    } catch (error) {
      return null;
    }
  }

  function getReturnPath() {
    return `${window.location.pathname}${window.location.search}${window.location.hash}` || "/";
  }

  function normalizeClaimValues(value) {
    if (Array.isArray(value)) {
      return value
        .map((entry) => String(entry).trim().toLowerCase())
        .filter(Boolean);
    }

    if (typeof value === "string") {
      const trimmed = value.trim();

      if (
        (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
        (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
        (trimmed.startsWith("\"") && trimmed.endsWith("\""))
      ) {
        try {
          return normalizeClaimValues(JSON.parse(trimmed));
        } catch (error) {
        }
      }

      return value
        .split(/[\s,;|]+/)
        .map((entry) => entry.trim().toLowerCase().replace(/^[\[\]"']+|[\[\]"']+$/g, ""))
        .filter(Boolean);
    }

    if (typeof value === "number" || typeof value === "boolean") {
      return [String(value).trim().toLowerCase()];
    }

    return [];
  }

  function sessionClaims(input) {
    return input?.claims || input || {};
  }

  function hasMatchingClaim(values, target) {
    return values.some((value) => value === target);
  }

  function isTestAccount(input) {
    const claims = sessionClaims(input);
    const target = "test";
    const groups = normalizeClaimValues(claims["cognito:groups"]);

    if (hasMatchingClaim(groups, target)) {
      return true;
    }

    const tagKeys = ["custom:tag", "custom:tags", "tag", "tags"];
    const tagValues = tagKeys.flatMap((key) => normalizeClaimValues(claims[key]));

    if (hasMatchingClaim(tagValues, target)) {
      return true;
    }

    const booleanStyleKeys = ["custom:test", "test"];
    return booleanStyleKeys.some((key) => {
      const values = normalizeClaimValues(claims[key]);
      return hasMatchingClaim(values, "true") || hasMatchingClaim(values, target);
    });
  }

  function getGalleryCollection(input) {
    return isTestAccount(input) ? "test" : "months";
  }

  function getGalleryDestination(input) {
    const collection = getGalleryCollection(input);
    return collection === "test" ? "/gallery/test/" : "/gallery/months/";
  }

  function getPopupFeatures() {
    const width = 460;
    const height = 760;
    const left = Math.max(0, Math.round(window.screenX + (window.outerWidth - width) / 2));
    const top = Math.max(0, Math.round(window.screenY + (window.outerHeight - height) / 2));

    return [
      `width=${width}`,
      `height=${height}`,
      `left=${left}`,
      `top=${top}`,
      "popup=yes",
      "resizable=yes",
      "scrollbars=yes",
    ].join(",");
  }

  function openAuthPopup() {
    const popup = window.open("", POPUP_NAME, getPopupFeatures());

    if (!popup) {
      return null;
    }

    try {
      popup.document.title = "Lilly's Vault Sign In";
      popup.document.body.style.margin = "0";
      popup.document.body.style.fontFamily = "Inter, sans-serif";
      popup.document.body.style.minHeight = "100vh";
      popup.document.body.style.display = "grid";
      popup.document.body.style.placeItems = "center";
      popup.document.body.style.background = "linear-gradient(180deg, #f6fff9 0%, #ffffff 100%)";
      popup.document.body.innerHTML =
        '<div style="padding:24px 28px;border-radius:24px;background:white;box-shadow:0 24px 60px -24px rgba(15,23,42,0.24);text-align:center;color:#065f46;font-size:15px;line-height:1.6;">Opening secure sign-in…</div>';
    } catch (error) {
    }

    return popup;
  }

  async function startLogin(options = {}) {
    const config = getConfig(options);
    const usePopup = Boolean(options.popup);
    const popupWindow = usePopup ? openAuthPopup() : null;

    if (!config.baseUrl || !config.clientId) {
      if (popupWindow && !popupWindow.closed) {
        popupWindow.close();
      }
      throw new Error("Missing Cognito Hosted UI configuration.");
    }

    if (usePopup && !popupWindow) {
      throw new Error("Please allow the secure sign-in popup to continue.");
    }

    const verifier = generateRandomString(96);
    const challenge = await createCodeChallenge(verifier);
    const state = generateRandomString(48);
    const nonce = generateRandomString(48);

    const pendingPayload = {
      verifier,
      state,
      remember: Boolean(options.remember),
      returnTo: options.returnTo || getReturnPath(),
      createdAt: Date.now(),
    };

    if (usePopup) {
      setStoragePayload(localStorage, POPUP_PENDING_KEY, pendingPayload);
    } else {
      setStoragePayload(sessionStorage, PENDING_KEY, pendingPayload);
    }

    const url = new URL(`${config.baseUrl}/oauth2/authorize`);
    url.searchParams.set("client_id", config.clientId);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", config.scope);
    url.searchParams.set("redirect_uri", config.redirectUri);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("state", state);
    url.searchParams.set("nonce", nonce);

    if (options.loginHint) {
      url.searchParams.set("login_hint", options.loginHint);
    }

    if (usePopup) {
      return await new Promise((resolve, reject) => {
        let finished = false;
        let closePoll = null;

        function cleanup() {
          finished = true;
          window.removeEventListener("message", onMessage);
          if (closePoll) {
            window.clearInterval(closePoll);
          }
        }

        function onMessage(event) {
          if (event.origin !== window.location.origin) {
            return;
          }

          if (event.data?.type !== POPUP_MESSAGE_TYPE) {
            return;
          }

          cleanup();

          if (popupWindow && !popupWindow.closed) {
            popupWindow.close();
          }

          if (event.data.error) {
            reject(new Error(event.data.error));
            return;
          }

          resolve(event.data);
        }

        window.addEventListener("message", onMessage);
        closePoll = window.setInterval(() => {
          if (!finished && popupWindow?.closed) {
            cleanup();
            localStorage.removeItem(POPUP_PENDING_KEY);
            reject(new Error("Secure sign-in was closed before it finished."));
          }
        }, 350);

        popupWindow.location.assign(url.toString());
      });
    }

    window.location.assign(url.toString());
  }

  async function requestTokens(params) {
    const response = await fetch(params.tokenUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(params.body),
    });

    const payload = await response.json().catch(() => null);

    if (!response.ok) {
      const message = payload?.error_description || payload?.error || "Token request failed.";
      throw new Error(message);
    }

    return payload;
  }

  async function handleCallback(options = {}) {
    const config = getConfig(options);
    const searchParams = new URLSearchParams(window.location.search);
    const code = searchParams.get("code");
    const state = searchParams.get("state");
    const oauthError = searchParams.get("error");
    const oauthErrorDescription = searchParams.get("error_description");

    if (oauthError) {
      throw new Error(oauthErrorDescription || oauthError);
    }

    if (!code || !state) {
      throw new Error("Missing authorization code.");
    }

    const matchedPending = getMatchingPendingState(state);

    if (!matchedPending?.pending) {
      throw new Error("Missing stored login state.");
    }

    const { pending, kind } = matchedPending;

    if (pending.state !== state) {
      clearStoredPending(kind);
      throw new Error("State mismatch during secure sign-in.");
    }

    const tokenResponse = await requestTokens({
      tokenUrl: `${config.baseUrl}/oauth2/token`,
      body: {
        grant_type: "authorization_code",
        client_id: config.clientId,
        code,
        code_verifier: pending.verifier,
        redirect_uri: config.redirectUri,
      },
    });

    const claims = tokenResponse.id_token ? decodeJwt(tokenResponse.id_token) : null;
    const session = {
      tokens: tokenResponse,
      claims,
      expiresAt: Date.now() + (tokenResponse.expires_in || 3600) * 1000,
      baseUrl: config.baseUrl,
      clientId: config.clientId,
      logoutUri: config.logoutUri,
    };

    if (kind === "popup") {
      clearStoredPending(kind);
    } else {
      saveSession(session, pending.remember);
      clearStoredPending(kind);
    }

    return {
      session,
      returnTo: pending.returnTo || "/",
      remember: Boolean(pending.remember),
      popup: kind === "popup",
    };
  }

  async function refreshSession(session, options = {}) {
    if (!session?.tokens?.refresh_token) {
      return null;
    }

    const config = getConfig(options);
    const refreshed = await requestTokens({
      tokenUrl: `${config.baseUrl}/oauth2/token`,
      body: {
        grant_type: "refresh_token",
        client_id: config.clientId,
        refresh_token: session.tokens.refresh_token,
      },
    });

    const nextSession = {
      ...session,
      tokens: {
        ...session.tokens,
        ...refreshed,
        refresh_token: refreshed.refresh_token || session.tokens.refresh_token,
      },
      claims: refreshed.id_token ? decodeJwt(refreshed.id_token) : session.claims,
      expiresAt: Date.now() + (refreshed.expires_in || 3600) * 1000,
      baseUrl: config.baseUrl,
      clientId: config.clientId,
      logoutUri: config.logoutUri,
    };

    saveSession(nextSession, isRememberedSession());
    return nextSession;
  }

  async function getSession(options = {}) {
    const session = getStoredSession();

    if (!session) {
      return null;
    }

    if (session.expiresAt && session.expiresAt > Date.now() + EXPIRY_SKEW_MS) {
      return session;
    }

    try {
      return await refreshSession(session, options);
    } catch (error) {
      clearSession();
      return null;
    }
  }

  function signOut(options = {}) {
    const config = getConfig(options);
    try { localStorage.setItem("everydayLillyAuth:logout", String(Date.now())); } catch (error) {}

    clearPendingState();
    clearSession();

    if (!config.baseUrl || !config.clientId) {
      window.location.assign(config.logoutUri || "/");
      return;
    }

    const url = new URL(`${config.baseUrl}/logout`);
    url.searchParams.set("client_id", config.clientId);
    url.searchParams.set("logout_uri", config.logoutUri);
    window.location.assign(url.toString());
  }

  window.EverydayLillyAuth = {
    clearPendingState,
    clearSession,
    completePopupLogin,
    getConfig,
    getGalleryCollection,
    getGalleryDestination,
    getSession,
    handleCallback,
    isTestAccount,
    signOut,
    startLogin,
  };
})();
