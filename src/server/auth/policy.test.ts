import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  accessDecision,
  assertSafeMetadata,
  authMessages,
  canRemoveVerifiedFactor,
  classifyPasswordUpdateFailure,
  clientRateLimitIdentity,
  isVercelDeployment,
  continuationPath,
  destinationAfterPasswordChange,
  passwordIsAcceptable,
  proxyDecision,
  recoveryCallbackDestination,
  recoveryGrantsApplicationAccess,
  resolveAppOrigin,
  safeNext,
} from "./policy.ts";

const anonymous = {
  hasSession: false,
  emailConfirmed: false,
  assurance: null,
  verifiedTotp: false,
} as const;

const aal1 = {
  hasSession: true,
  emailConfirmed: true,
  assurance: "aal1" as const,
  verifiedTotp: true,
};

const enrolledAal1 = aal1;

const unenrolled = {
  hasSession: true,
  emailConfirmed: true,
  assurance: "aal1" as const,
  verifiedTotp: false,
};

const aal2 = {
  hasSession: true,
  emailConfirmed: true,
  assurance: "aal2" as const,
  verifiedTotp: true,
};

describe("protected routes", () => {
  it("sends an anonymous visitor from a protected route to login", () => {
    const decision = accessDecision(anonymous, "/performance");
    assert.equal(decision.allow, false);
    assert.equal(decision.redirectTo, "/login?next=%2Fperformance");
  });

  it("rejects an AAL1 session on a protected route", () => {
    const decision = accessDecision(enrolledAal1, "/commercial");
    assert.equal(decision.allow, false);
    assert.match(decision.redirectTo ?? "", /^\/mfa\/verify/);
  });

  it("sends a signed-in user without TOTP to enrollment", () => {
    const decision = accessDecision(unenrolled, "/settings");
    assert.equal(decision.redirectTo, "/mfa/enroll");
  });

  it("allows an AAL2 session with TOTP into the application", () => {
    const decision = accessDecision(aal2, "/intelligence");
    assert.deepEqual(decision, { allow: true, redirectTo: null });
  });

  it("denies AAL2 when no verified TOTP factor is present", () => {
    const decision = accessDecision(
      { ...aal2, verifiedTotp: false },
      "/performance",
    );
    assert.equal(decision.allow, false);
    assert.equal(decision.redirectTo, "/mfa/enroll");
  });

  it("does not let a direct application URL skip MFA", () => {
    assert.equal(accessDecision(anonymous, "/reports").allow, false);
    assert.equal(accessDecision(unenrolled, "/planner").allow, false);
    assert.equal(accessDecision(aal1, "/audience").allow, false);
  });
});

describe("authentication pages", () => {
  it("keeps login available to anonymous visitors", () => {
    assert.equal(accessDecision(anonymous, "/login").allow, true);
  });

  it("moves a completed MFA session away from login", () => {
    assert.equal(accessDecision(aal2, "/login").redirectTo, "/");
    assert.equal(accessDecision(aal2, "/signup").redirectTo, "/");
  });

  it("ignores an external next path", () => {
    assert.equal(safeNext("https://evil.example"), null);
    assert.equal(safeNext("//evil.example"), null);
    assert.equal(accessDecision(aal2, "/login", "https://evil.example").redirectTo, "/");
  });
});

describe("MFA and recovery", () => {
  it("blocks removal of the only verified factor", () => {
    assert.equal(canRemoveVerifiedFactor(1), false);
    assert.equal(canRemoveVerifiedFactor(0), false);
    assert.equal(canRemoveVerifiedFactor(2), true);
  });

  it("sends password recovery to MFA instead of the application", () => {
    assert.equal(destinationAfterPasswordChange(true), "/mfa/verify");
    assert.equal(destinationAfterPasswordChange(false), "/mfa/enroll");
    assert.equal(recoveryGrantsApplicationAccess(), false);
    assert.equal(accessDecision(aal1, "/reset-password").allow, true);
    assert.equal(accessDecision(aal1, "/").allow, false);
  });

  it("sends a recovery session with verified TOTP to MFA before the reset page", () => {
    assert.equal(
      recoveryCallbackDestination(true),
      "/mfa/verify?next=%2Freset-password",
    );
  });

  it("keeps recovery without verified TOTP on the reset page", () => {
    assert.equal(recoveryCallbackDestination(false), "/reset-password");
  });

  it("returns a completed TOTP check to the reset page", () => {
    assert.equal(continuationPath("/reset-password"), "/reset-password");
    assert.equal(
      accessDecision(aal2, "/mfa/verify", "/reset-password").redirectTo,
      "/reset-password",
    );
  });

  it("rejects a recovery return path that is not the reset page", () => {
    assert.equal(continuationPath("/reset-password/extra"), null);
    assert.equal(continuationPath("/reset-password?next=/"), null);
    assert.equal(continuationPath("//reset-password"), null);
    assert.equal(safeNext("/reset-password"), null);
  });

  it("does not let an AAL1 recovery session open a protected route", () => {
    const decision = accessDecision(aal1, "/performance", "/reset-password");
    assert.equal(decision.allow, false);
    assert.match(decision.redirectTo ?? "", /^\/mfa\/verify/);
    assert.equal(proxyDecision({ sub: "user", aal: "aal1" }, "/performance").redirectTo?.includes("/performance") ?? false, false);
    assert.equal(recoveryCallbackDestination(true).startsWith("/performance"), false);
    assert.equal(recoveryCallbackDestination(false).startsWith("/"), true);
    assert.equal(recoveryCallbackDestination(false).includes("/performance"), false);
  });

  it("does not treat the recovery page as application access", () => {
    assert.equal(accessDecision(anonymous, "/mfa/recovery").allow, true);
    assert.equal(accessDecision(anonymous, "/").allow, false);
  });
});

describe("proxy routing", () => {
  it("redirects an anonymous request before the application renders", () => {
    assert.equal(proxyDecision(null, "/cross-media").redirectTo, "/login?next=%2Fcross-media");
  });

  it("redirects an AAL1 session to verification", () => {
    assert.match(
      proxyDecision({ sub: "user", aal: "aal1" }, "/reports").redirectTo ?? "",
      /^\/mfa\/verify/,
    );
  });

  it("lets an AAL2 session through and away from login", () => {
    assert.equal(proxyDecision({ sub: "user", aal: "aal2" }, "/reports").redirectTo, null);
    assert.equal(proxyDecision({ sub: "user", aal: "aal2" }, "/login").redirectTo, "/");
  });
});

describe("client rate-limit identity", () => {
  it("accepts one Vercel client address", () => {
    assert.equal(isVercelDeployment({ vercel: "1" }), true);
    assert.equal(isVercelDeployment({ vercelEnv: "production" }), true);
    assert.equal(isVercelDeployment({ vercelEnv: "preview" }), true);
    assert.equal(
      clientRateLimitIdentity({ vercel: true, trustedForwardedFor: "203.0.113.10" }),
      "203.0.113.10",
    );
    assert.equal(
      clientRateLimitIdentity({ vercel: true, trustedForwardedFor: "2001:db8::1" }),
      "2001:db8::1",
    );
  });

  it("fails closed when a Vercel deployment has no single trusted address", () => {
    assert.equal(isVercelDeployment({}), false);
    assert.equal(isVercelDeployment({ vercelEnv: "" }), false);
    for (const trustedForwardedFor of [
      null,
      "",
      "   ",
      "not-an-address",
      "203.0.113.10,198.51.100.1",
      "203.0.113.10, 198.51.100.1",
    ]) {
      assert.equal(clientRateLimitIdentity({ vercel: true, trustedForwardedFor }), null);
    }
  });

  it("does not accept a spoofed forwarding header as the Vercel client", () => {
    assert.equal(
      clientRateLimitIdentity({ vercel: true, trustedForwardedFor: null }),
      null,
    );
    assert.equal(
      clientRateLimitIdentity({
        vercel: true,
        trustedForwardedFor: "203.0.113.10, 198.51.100.1",
      }),
      null,
    );
    assert.equal(
      clientRateLimitIdentity({ vercel: true, trustedForwardedFor: "198.51.100.8, 203.0.113.10" }),
      null,
    );
  });

  it("keeps local development on the shared identity", () => {
    assert.equal(clientRateLimitIdentity({ vercel: false, trustedForwardedFor: null }), "local");
    assert.equal(
      clientRateLimitIdentity({
        vercel: false,
        trustedForwardedFor: "203.0.113.10, 198.51.100.1",
      }),
      "local",
    );
    assert.equal(
      clientRateLimitIdentity({ vercel: false, trustedForwardedFor: "198.51.100.8" }),
      "local",
    );
    assert.equal(
      clientRateLimitIdentity({ vercel: false, trustedForwardedFor: "203.0.113.10" }),
      "local",
    );
  });
});

describe("application origin", () => {
  it("accepts an HTTPS site URL and removes a trailing slash", () => {
    assert.deepEqual(
      resolveAppOrigin({
        siteUrl: "https://mediaiq.example/",
        nodeEnv: "production",
        host: "evil.example",
        protocol: "http",
      }),
      { ok: true, origin: "https://mediaiq.example" },
    );
  });

  it("accepts localhost HTTP only outside production", () => {
    assert.deepEqual(
      resolveAppOrigin({
        siteUrl: "http://127.0.0.1:3000/",
        nodeEnv: "development",
        host: null,
        protocol: null,
      }),
      { ok: true, origin: "http://127.0.0.1:3000" },
    );
    assert.deepEqual(
      resolveAppOrigin({
        siteUrl: "http://localhost:3000",
        nodeEnv: "development",
        host: "evil.example",
        protocol: "https",
      }),
      { ok: true, origin: "http://localhost:3000" },
    );
  });

  it("uses the local development origin when SITE_URL is absent", () => {
    assert.deepEqual(
      resolveAppOrigin({
        siteUrl: undefined,
        nodeEnv: "development",
        host: "localhost:3000",
        protocol: "http",
      }),
      { ok: true, origin: "http://localhost:3000" },
    );
    assert.deepEqual(
      resolveAppOrigin({
        siteUrl: "   ",
        nodeEnv: "development",
        host: "evil.example",
        protocol: "https",
      }),
      { ok: true, origin: "http://127.0.0.1:3000" },
    );
  });

  it("rejects malformed, credentialed, and non-origin site URLs", () => {
    for (const siteUrl of [
      "mediaiq.example",
      "https://user:secret@mediaiq.example",
      "https://mediaiq.example/auth/confirm/enroll",
      "https://mediaiq.example?next=/",
      "https://mediaiq.example#reset",
      "ftp://mediaiq.example",
      " https://mediaiq.example",
    ]) {
      assert.deepEqual(
        resolveAppOrigin({ siteUrl, nodeEnv: "production", host: null, protocol: null }),
        { ok: false },
      );
    }
  });

  it("rejects HTTP and a missing site URL in production", () => {
    assert.deepEqual(
      resolveAppOrigin({
        siteUrl: "http://mediaiq.example",
        nodeEnv: "production",
        host: "mediaiq.example",
        protocol: "https",
      }),
      { ok: false },
    );
    assert.deepEqual(
      resolveAppOrigin({
        siteUrl: "http://localhost:3000",
        nodeEnv: "production",
        host: null,
        protocol: null,
      }),
      { ok: false },
    );
    assert.deepEqual(
      resolveAppOrigin({ siteUrl: undefined, nodeEnv: "production", host: "localhost:3000", protocol: "http" }),
      { ok: false },
    );
  });
});

describe("audit metadata and messages", () => {
  it("rejects sensitive authentication fields", () => {
    assert.throws(() => assertSafeMetadata({ totp_secret: "abc" }));
    assert.throws(() => assertSafeMetadata({ code: "123456" }));
    assert.throws(() => assertSafeMetadata({ access_token: "token" }));
    assert.doesNotThrow(() => assertSafeMetadata({ factor_count: 1, method: "totp" }));
  });

  it("classifies a password update rejection without the provider message", () => {
    const assurance = classifyPasswordUpdateFailure({
      code: "insufficient_aal",
      status: 401,
      message: "AAL2 session is required to update email or password when MFA is enabled.",
    });
    assert.equal(assurance.category, "assurance_required");
    assert.equal(assurance.providerFailure, "insufficient_aal");
    assert.equal(assurance.providerStatus, "401");
    assert.equal(assurance.redirectTo, "/mfa/verify?next=%2Freset-password");
    assert.equal(assurance.browserMessage, authMessages.generic);
    assert.equal(JSON.stringify(assurance).includes("AAL2 session"), false);
    assert.doesNotThrow(() =>
      assertSafeMetadata({
        method: "recovery",
        failure_category: assurance.category,
        provider_failure: assurance.providerFailure,
        provider_status: assurance.providerStatus,
      }),
    );

    const same = classifyPasswordUpdateFailure({
      code: "same_password",
      status: 422,
      message: "New password should be different from the old password.",
    });
    assert.equal(same.category, "same_password");
    assert.equal(same.redirectTo, null);
    assert.equal(same.browserMessage, authMessages.generic);
    assert.equal(JSON.stringify(same).includes("different"), false);

    const weak = classifyPasswordUpdateFailure({
      code: "weak_password",
      status: 422,
      message: "Password should be at least 12 characters",
    });
    assert.equal(weak.browserMessage, authMessages.passwordRules);
    assert.equal(JSON.stringify(weak).includes("Password should be"), false);

    const other = classifyPasswordUpdateFailure({
      code: "session expired token",
      status: 500,
      message: "provider detail",
    });
    assert.equal(other.category, "rejected");
    assert.equal(other.providerFailure, "unclassified");
    assert.equal(other.browserMessage, authMessages.generic);
    assert.equal(JSON.stringify(other).includes("provider detail"), false);
  });

  it("keeps credential failures generic", () => {
    assert.equal(authMessages.invalidCredentials.includes("@"), false);
    assert.equal(authMessages.checkEmail.toLowerCase().includes("already"), false);
    assert.equal(authMessages.resetSent.toLowerCase().includes("not found"), false);
  });

  it("requires a long mixed password", () => {
    assert.equal(passwordIsAcceptable("short"), false);
    assert.equal(passwordIsAcceptable("alllowercase12"), false);
    assert.equal(passwordIsAcceptable("MediaIQ-Test-12"), true);
  });
});
