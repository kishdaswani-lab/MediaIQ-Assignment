import { isIP } from "node:net";

export type Assurance = "aal1" | "aal2";

export type AuthContext = {
  hasSession: boolean;
  emailConfirmed: boolean;
  assurance: Assurance | null;
  verifiedTotp: boolean;
};

export type AccessDecision = {
  allow: boolean;
  redirectTo: string | null;
};

const PUBLIC_AUTH_PATHS = new Set([
  "/login",
  "/signup",
  "/forgot-password",
  "/reset-password",
  "/mfa/enroll",
  "/mfa/verify",
  "/mfa/recovery",
]);

const FORBIDDEN_METADATA_KEY = /password|secret|token|totp|otp|qr|uri|code/i;
const LOCAL_DEVELOPMENT_ORIGINS = new Set(["http://127.0.0.1:3000", "http://localhost:3000"]);

export type AppOriginInput = {
  siteUrl: string | undefined;
  nodeEnv: string | undefined;
  host: string | null;
  protocol: string | null;
};

export type AppOrigin = { ok: true; origin: string } | { ok: false };

export type ClientRateLimitInput = {
  vercel: boolean;
  trustedForwardedFor: string | null;
};

export function isVercelDeployment(env: { vercel?: string; vercelEnv?: string }): boolean {
  return env.vercel === "1" || (typeof env.vercelEnv === "string" && env.vercelEnv.length > 0);
}

export function clientRateLimitIdentity(input: ClientRateLimitInput): string | null {
  if (!input.vercel) {
    return "local";
  }

  const address = input.trustedForwardedFor;
  if (address === null || address.length === 0 || address !== address.trim() || address.includes(",")) {
    return null;
  }

  return isIP(address) === 0 ? null : address;
}

export function resolveAppOrigin(input: AppOriginInput): AppOrigin {
  const production = input.nodeEnv === "production";
  const configured = input.siteUrl;

  if (configured !== undefined && configured.trim() !== "") {
    const origin = configuredSiteOrigin(configured, production);
    return origin ? { ok: true, origin } : { ok: false };
  }

  if (production) {
    return { ok: false };
  }

  const protocol = input.protocol ?? "http";
  const origin = input.host ? `${protocol}://${input.host}` : "http://127.0.0.1:3000";
  return { ok: true, origin: LOCAL_DEVELOPMENT_ORIGINS.has(origin) ? origin : "http://127.0.0.1:3000" };
}

function configuredSiteOrigin(siteUrl: string, production: boolean): string | null {
  if (siteUrl !== siteUrl.trim()) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(siteUrl);
  } catch {
    return null;
  }

  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    return null;
  }

  if (url.pathname !== "/" && url.pathname !== "") {
    return null;
  }

  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (url.protocol === "https:") {
    return url.origin;
  }

  if (!production && url.protocol === "http:" && loopback) {
    return url.origin;
  }

  return null;
}

export const authMessages = {
  invalidCredentials: "Email or password is incorrect.",
  checkEmail:
    "If this address can be registered, we sent instructions to verify it. Check your inbox before trying to sign in.",
  resetSent:
    "If an account exists for that email, we sent password reset instructions.",
  mfaRejected: "That code was not accepted.",
  rateLimited: "Too many attempts. Wait and try again.",
  sessionExpired: "Your session has expired. Sign in again.",
  auditFailed: "We could not complete that securely. Sign in again.",
  lastFactor:
    "An authenticator is required. Add a replacement before removing this one.",
  linkInvalid: "That link is invalid or expired. Request a new one.",
  verifyEmail: "Verify your email before continuing.",
  passwordRules:
    "Use at least 12 characters, with an uppercase letter, a lowercase letter, and a digit.",
  generic: "That request could not be completed.",
} as const;

export function isPublicAuthPath(pathname: string): boolean {
  return PUBLIC_AUTH_PATHS.has(pathname);
}

export function isProtectedPath(pathname: string): boolean {
  if (isPublicAuthPath(pathname) || pathname.startsWith("/auth/confirm/")) {
    return false;
  }

  return true;
}

export function continuationPath(value: string | null | undefined): string | null {
  if (value === "/reset-password") {
    return "/reset-password";
  }

  return safeNext(value);
}

export function recoveryCallbackDestination(verifiedTotp: boolean): string {
  if (verifiedTotp) {
    return "/mfa/verify?next=%2Freset-password";
  }

  return "/reset-password";
}

export function safeNext(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    value.includes("://") ||
    value.includes("?") ||
    value.includes("#")
  ) {
    return null;
  }

  if (
    value.startsWith("/login") ||
    value.startsWith("/signup") ||
    value.startsWith("/mfa") ||
    value.startsWith("/auth") ||
    value.startsWith("/forgot-password") ||
    value.startsWith("/reset-password")
  ) {
    return null;
  }

  return value;
}

export function accessDecision(
  context: AuthContext,
  pathname: string,
  requestedNext?: string | null,
): AccessDecision {
  const next = continuationPath(requestedNext) ?? "/";

  if (pathname.startsWith("/auth/confirm/")) {
    return { allow: true, redirectTo: null };
  }

  if (!context.hasSession) {
    if (
      isProtectedPath(pathname) ||
      pathname === "/mfa/enroll" ||
      pathname === "/mfa/verify"
    ) {
      const destination = isProtectedPath(pathname) ? pathname : "/";
      return {
        allow: false,
        redirectTo: `/login?next=${encodeURIComponent(destination)}`,
      };
    }

    return { allow: true, redirectTo: null };
  }

  if (!context.emailConfirmed) {
    if (isProtectedPath(pathname) || pathname.startsWith("/mfa/")) {
      return { allow: false, redirectTo: "/signup?notice=verify" };
    }
  }

  if (isProtectedPath(pathname)) {
    if (!context.verifiedTotp) {
      return { allow: false, redirectTo: "/mfa/enroll" };
    }

    if (context.assurance !== "aal2") {
      return {
        allow: false,
        redirectTo: `/mfa/verify?next=${encodeURIComponent(pathname)}`,
      };
    }

    return { allow: true, redirectTo: null };
  }

  if (pathname === "/login" || pathname === "/signup") {
    if (!context.emailConfirmed) {
      return { allow: true, redirectTo: null };
    }

    if (!context.verifiedTotp) {
      return { allow: false, redirectTo: "/mfa/enroll" };
    }

    if (context.assurance !== "aal2") {
      return { allow: false, redirectTo: "/mfa/verify" };
    }

    return { allow: false, redirectTo: next };
  }

  if (pathname === "/forgot-password") {
    if (context.emailConfirmed && context.verifiedTotp && context.assurance === "aal2") {
      return { allow: false, redirectTo: "/" };
    }

    return { allow: true, redirectTo: null };
  }

  if (pathname === "/mfa/enroll") {
    if (!context.emailConfirmed) {
      return { allow: false, redirectTo: "/signup?notice=verify" };
    }

    if (context.verifiedTotp && context.assurance === "aal2") {
      return { allow: false, redirectTo: "/" };
    }

    if (context.verifiedTotp) {
      return { allow: false, redirectTo: "/mfa/verify" };
    }

    return { allow: true, redirectTo: null };
  }

  if (pathname === "/mfa/verify") {
    if (!context.emailConfirmed) {
      return { allow: false, redirectTo: "/signup?notice=verify" };
    }

    if (!context.verifiedTotp) {
      return { allow: false, redirectTo: "/mfa/enroll" };
    }

    if (context.assurance === "aal2") {
      return { allow: false, redirectTo: next };
    }

    return { allow: true, redirectTo: null };
  }

  return { allow: true, redirectTo: null };
}

export function proxyDecision(
  claims: { sub?: string; aal?: string } | null,
  pathname: string,
): { redirectTo: string | null } {
  const context: AuthContext = {
    hasSession: Boolean(claims?.sub),
    emailConfirmed: true,
    assurance: claims?.aal === "aal2" ? "aal2" : claims?.sub ? "aal1" : null,
    verifiedTotp: claims?.aal === "aal2",
  };

  if (!context.hasSession) {
    return {
      redirectTo: accessDecision(context, pathname).redirectTo,
    };
  }

  if (context.assurance !== "aal2" && isProtectedPath(pathname)) {
    return {
      redirectTo: `/mfa/verify?next=${encodeURIComponent(pathname)}`,
    };
  }

  if (
    context.assurance === "aal2" &&
    (pathname === "/login" ||
      pathname === "/signup" ||
      pathname === "/mfa/enroll" ||
      pathname === "/mfa/verify" ||
      pathname === "/forgot-password")
  ) {
    return { redirectTo: "/" };
  }

  if (
    context.assurance === "aal1" &&
    (pathname === "/login" || pathname === "/signup")
  ) {
    return { redirectTo: "/mfa/verify" };
  }

  return { redirectTo: null };
}

export function canRemoveVerifiedFactor(verifiedTotpCount: number): boolean {
  return verifiedTotpCount > 1;
}

export function destinationAfterPasswordChange(verifiedTotp: boolean): string {
  return verifiedTotp ? "/mfa/verify" : "/mfa/enroll";
}

export function recoveryGrantsApplicationAccess(): boolean {
  return false;
}

export type PasswordUpdateFailure = {
  category:
    | "assurance_required"
    | "reauthentication_required"
    | "same_password"
    | "weak_password"
    | "rejected";
  providerFailure: string;
  providerStatus: string;
  redirectTo: "/mfa/verify?next=%2Freset-password" | null;
  browserMessage: string;
};

const authFailureName = /^[a-z0-9_]{1,64}$/;

export function classifyPasswordUpdateFailure(error: {
  code?: unknown;
  status?: unknown;
  message?: unknown;
}): PasswordUpdateFailure {
  void error.message;
  const providerFailure =
    typeof error.code === "string" && authFailureName.test(error.code)
      ? error.code
      : "unclassified";
  const providerStatus =
    typeof error.status === "number" &&
    Number.isInteger(error.status) &&
    error.status >= 100 &&
    error.status <= 599
      ? String(error.status)
      : "0";
  const category =
    providerFailure === "insufficient_aal"
      ? "assurance_required"
      : providerFailure === "reauthentication_needed"
        ? "reauthentication_required"
        : providerFailure === "same_password"
          ? "same_password"
          : providerFailure === "weak_password"
            ? "weak_password"
            : "rejected";

  return {
    category,
    providerFailure,
    providerStatus,
    redirectTo:
      category === "assurance_required" ? "/mfa/verify?next=%2Freset-password" : null,
    browserMessage:
      category === "weak_password" ? authMessages.passwordRules : authMessages.generic,
  };
}

export function assertSafeMetadata(metadata: Record<string, unknown>): void {
  const encoded = JSON.stringify(metadata);

  if (encoded.length > 2000) {
    throw new Error("metadata rejected");
  }

  for (const key of Object.keys(metadata)) {
    if (FORBIDDEN_METADATA_KEY.test(key)) {
      throw new Error("metadata rejected");
    }
  }
}

export function passwordIsAcceptable(password: string): boolean {
  return (
    password.length >= 12 &&
    /[a-z]/.test(password) &&
    /[A-Z]/.test(password) &&
    /\d/.test(password)
  );
}

export function noticeMessage(notice: string | undefined): string | null {
  if (notice === "verify") {
    return authMessages.verifyEmail;
  }

  if (notice === "link") {
    return authMessages.linkInvalid;
  }

  if (notice === "expired") {
    return authMessages.sessionExpired;
  }

  return null;
}
