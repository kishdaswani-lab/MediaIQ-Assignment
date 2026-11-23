"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import type { Factor, SupabaseClient } from "@supabase/supabase-js";
import { consumeSecurityAttempt, recordSecurityEvent } from "@/server/auth/audit";
import {
  assertSafeMetadata,
  authMessages,
  canRemoveVerifiedFactor,
  classifyPasswordUpdateFailure,
  continuationPath,
  destinationAfterPasswordChange,
  passwordIsAcceptable,
  resolveAppOrigin,
} from "@/server/auth/policy";
import { createSupabase, readAuthSnapshot } from "@/server/auth/session";

export type AuthFormState = {
  error?: string;
  message?: string;
  enrollment?: {
    factorId: string;
    qrCode: string;
    secret: string;
    previousFactorId?: string;
  };
};

async function appOrigin(): Promise<string | null> {
  const headerStore = await headers();
  const resolved = resolveAppOrigin({
    siteUrl: process.env.SITE_URL,
    nodeEnv: process.env.NODE_ENV,
    host: headerStore.get("x-forwarded-host") ?? headerStore.get("host"),
    protocol: headerStore.get("x-forwarded-proto"),
  });

  return resolved.ok ? resolved.origin : null;
}

async function requireSession(): Promise<{ supabase: SupabaseClient; userId: string }> {
  const supabase = await createSupabase();
  const { data, error } = await supabase.auth.getClaims();

  if (error) {
    await recordSecurityEvent({
      eventType: "auth.session.rejected",
      outcome: "failure",
      metadata: { reason: "invalid_session" },
    });
    redirect("/login?notice=expired");
  }

  if (!data?.claims?.sub) {
    redirect("/login?notice=expired");
  }

  return { supabase, userId: data.claims.sub };
}

async function requireRecentMfa(): Promise<{ supabase: SupabaseClient; userId: string }> {
  const session = await requireSession();
  const { data } = await session.supabase.auth.getClaims();

  if (data?.claims?.aal !== "aal2") {
    redirect("/mfa/verify");
  }

  return session;
}

function verifiedTotpFactors(factors: Factor[]): Factor[] {
  return factors.filter(
    (factor) => factor.factor_type === "totp" && factor.status === "verified",
  );
}

async function loadFactors(supabase: SupabaseClient): Promise<Factor[] | null> {
  const { data, error } = await supabase.auth.mfa.listFactors();

  if (error || !data) {
    return null;
  }

  return data.all;
}

async function removeUnverifiedTotp(supabase: SupabaseClient, factors: Factor[]) {
  for (const factor of factors) {
    if (factor.factor_type === "totp" && factor.status !== "verified") {
      await supabase.auth.mfa.unenroll({ factorId: factor.id });
    }
  }
}

async function accountsFor(supabase: SupabaseClient, userId: string): Promise<string[]> {
  const { data } = await supabase.auth.getUser();
  const email = data.user?.email?.trim();

  return email ? [userId, email] : [userId];
}

async function gate(action: string, accounts: string[] = []): Promise<AuthFormState | null> {
  const attempt = await consumeSecurityAttempt(action, accounts);

  if (!attempt.allowed) {
    await recordSecurityEvent({
      eventType: "auth.rate_limited",
      outcome: "denied",
      metadata: { action },
    });
    return { error: authMessages.rateLimited };
  }

  return null;
}

async function failClosed(supabase: SupabaseClient): Promise<AuthFormState> {
  await supabase.auth.signOut({ scope: "local" });
  return { error: authMessages.auditFailed };
}

export async function signIn(
  _state: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const email = String(formData.get("email") ?? "").trim();
  const limited = await gate("login", email ? [email] : []);

  if (limited) {
    return limited;
  }
  const password = String(formData.get("password") ?? "");
  const supabase = await createSupabase();
  const { error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    await recordSecurityEvent({
      eventType: "auth.login.failed",
      outcome: "failure",
      metadata: { method: "password" },
    });
    return { error: authMessages.invalidCredentials };
  }

  const recorded = await recordSecurityEvent({
    eventType: "auth.login.succeeded",
    outcome: "success",
    metadata: { method: "password" },
  });

  if (!recorded) {
    return failClosed(supabase);
  }

  const factors = await loadFactors(supabase);
  redirect(factors && verifiedTotpFactors(factors).length > 0 ? "/mfa/verify" : "/mfa/enroll");
}

export async function signUp(
  _state: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const email = String(formData.get("email") ?? "").trim();
  const limited = await gate("signup", email ? [email] : []);

  if (limited) {
    return limited;
  }
  const password = String(formData.get("password") ?? "");

  if (!passwordIsAcceptable(password)) {
    return { error: authMessages.passwordRules };
  }

  const origin = await appOrigin();
  if (!origin) {
    return { error: authMessages.generic };
  }
  const supabase = await createSupabase();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: `${origin}/auth/confirm/enroll` },
  });

  if (
    error ||
    !data.user ||
    (Array.isArray(data.user.identities) && data.user.identities.length === 0)
  ) {
    await recordSecurityEvent({
      eventType: "auth.signup.rejected",
      outcome: "failure",
      metadata: { method: "password" },
    });
    return { message: authMessages.checkEmail };
  }

  if (!data.session) {
    await recordSecurityEvent({
      eventType: "auth.signup.requested",
      outcome: "success",
      metadata: { method: "password", confirmation: "required" },
    });
    return { message: authMessages.checkEmail };
  }

  const recorded = await recordSecurityEvent({
    eventType: "auth.signup.succeeded",
    outcome: "success",
    metadata: { method: "password", confirmation: "disabled" },
  });

  if (!recorded) {
    return failClosed(supabase);
  }

  redirect("/mfa/enroll");
}

export async function requestPasswordReset(
  _state: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const email = String(formData.get("email") ?? "").trim();
  const limited = await gate("recovery", email ? [email] : []);

  if (limited) {
    return limited;
  }
  const origin = await appOrigin();
  if (!origin) {
    return { error: authMessages.generic };
  }
  const supabase = await createSupabase();
  await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${origin}/auth/confirm/recovery`,
  });
  await recordSecurityEvent({
    eventType: "auth.password_reset.requested",
    outcome: "success",
    metadata: { method: "email" },
  });

  return { message: authMessages.resetSent };
}

export async function updatePassword(
  _state: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const password = String(formData.get("password") ?? "");
  const confirmation = String(formData.get("confirmation") ?? "");

  if (password !== confirmation || !passwordIsAcceptable(password)) {
    return { error: authMessages.passwordRules };
  }

  const { supabase, userId } = await requireSession();
  const limited = await gate("password_update", await accountsFor(supabase, userId));

  if (limited) {
    return limited;
  }

  const { error } = await supabase.auth.updateUser({ password });

  if (error) {
    const failure = classifyPasswordUpdateFailure(error);
    const metadata = {
      method: "recovery",
      failure_category: failure.category,
      provider_failure: failure.providerFailure,
      provider_status: failure.providerStatus,
    };
    assertSafeMetadata(metadata);
    await recordSecurityEvent({
      eventType: "auth.password_change.failed",
      outcome: "failure",
      metadata,
    });

    if (failure.redirectTo) {
      redirect(failure.redirectTo);
    }

    return { error: failure.browserMessage };
  }

  const recorded = await recordSecurityEvent({
    eventType: "auth.password_reset.completed",
    outcome: "success",
    metadata: { method: "recovery", mfa_bypassed: false },
  });

  if (!recorded) {
    return failClosed(supabase);
  }

  await supabase.auth.signOut({ scope: "others" });
  await recordSecurityEvent({
    eventType: "auth.session.revoked",
    outcome: "success",
    metadata: { scope: "others", reason: "password_reset" },
  });

  const factors = await loadFactors(supabase);
  redirect(
    destinationAfterPasswordChange(
      Boolean(factors && verifiedTotpFactors(factors).length > 0),
    ),
  );
}

export async function signOut(): Promise<void> {
  const supabase = await createSupabase();
  const snapshot = await readAuthSnapshot();

  if (snapshot) {
    await recordSecurityEvent({
      eventType: "auth.logout",
      outcome: "success",
      metadata: { scope: "global" },
    });
  }

  await supabase.auth.signOut({ scope: "global" });
  redirect("/login");
}

export async function beginTotpEnrollment(
  state: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  void state;
  void formData;
  const { supabase, userId } = await requireSession();
  const limited = await gate("mfa_enroll", await accountsFor(supabase, userId));

  if (limited) {
    return limited;
  }
  const factors = await loadFactors(supabase);

  if (!factors) {
    return { error: authMessages.generic };
  }

  if (verifiedTotpFactors(factors).length > 0) {
    redirect("/mfa/verify");
  }

  await removeUnverifiedTotp(supabase, factors);
  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: "totp",
    friendlyName: "MediaIQ",
    issuer: "MediaIQ",
  });

  if (error || data.type !== "totp") {
    await recordSecurityEvent({
      eventType: "auth.mfa.enroll.failed",
      outcome: "failure",
      metadata: { method: "totp" },
    });
    return { error: authMessages.generic };
  }

  const recorded = await recordSecurityEvent({
    eventType: "auth.mfa.enroll.started",
    outcome: "success",
    metadata: { method: "totp" },
    targetType: "mfa_factor",
    targetId: data.id,
  });

  if (!recorded) {
    await supabase.auth.mfa.unenroll({ factorId: data.id });
    return failClosed(supabase);
  }

  return {
    enrollment: {
      factorId: data.id,
      qrCode: data.totp.qr_code,
      secret: data.totp.secret,
    },
  };
}

async function verifyTotp(
  supabase: SupabaseClient,
  factorId: string,
  code: string,
): Promise<boolean> {
  const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId, code });
  return !error;
}

export async function verifyTotpEnrollment(
  _state: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const factorId = String(formData.get("factorId") ?? "");
  const code = String(formData.get("code") ?? "").trim();
  const { supabase, userId } = await requireSession();
  const limited = await gate("mfa_verify", await accountsFor(supabase, userId));

  if (limited) {
    return limited;
  }
  const verified = await verifyTotp(supabase, factorId, code);

  if (!verified) {
    await recordSecurityEvent({
      eventType: "auth.mfa.challenge.failed",
      outcome: "failure",
      metadata: { method: "totp", purpose: "enrollment" },
      targetType: "mfa_factor",
      targetId: factorId,
    });
    return { error: authMessages.mfaRejected };
  }

  const recorded = await recordSecurityEvent({
    eventType: "auth.mfa.enroll.verified",
    outcome: "success",
    metadata: { method: "totp" },
    targetType: "mfa_factor",
    targetId: factorId,
  });

  if (!recorded) {
    return failClosed(supabase);
  }

  redirect("/");
}

export async function verifyTotpLogin(
  _state: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const code = String(formData.get("code") ?? "").trim();
  const next = continuationPath(String(formData.get("next") ?? "")) ?? "/";
  const { supabase, userId } = await requireSession();
  const limited = await gate("mfa_verify", await accountsFor(supabase, userId));

  if (limited) {
    return limited;
  }
  const factors = await loadFactors(supabase);
  const factor = factors ? verifiedTotpFactors(factors)[0] : undefined;

  if (!factor) {
    redirect("/mfa/enroll");
  }

  const verified = await verifyTotp(supabase, factor.id, code);

  if (!verified) {
    await recordSecurityEvent({
      eventType: "auth.mfa.challenge.failed",
      outcome: "failure",
      metadata: { method: "totp", purpose: "login" },
      targetType: "mfa_factor",
      targetId: factor.id,
    });
    return { error: authMessages.mfaRejected };
  }

  const recorded = await recordSecurityEvent({
    eventType: "auth.mfa.challenge.verified",
    outcome: "success",
    metadata: { method: "totp", purpose: "login" },
    targetType: "mfa_factor",
    targetId: factor.id,
  });

  if (!recorded) {
    return failClosed(supabase);
  }

  redirect(next);
}

export async function startFactorReplacement(
  _state: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const code = String(formData.get("code") ?? "").trim();
  const { supabase, userId } = await requireRecentMfa();
  const limited = await gate("mfa_replace", await accountsFor(supabase, userId));

  if (limited) {
    return limited;
  }
  const factors = await loadFactors(supabase);
  const current = factors ? verifiedTotpFactors(factors)[0] : undefined;

  if (!factors || !current) {
    redirect("/mfa/enroll");
  }

  const confirmed = await verifyTotp(supabase, current.id, code);

  if (!confirmed) {
    await recordSecurityEvent({
      eventType: "auth.mfa.challenge.failed",
      outcome: "failure",
      metadata: { method: "totp", purpose: "replace" },
      targetType: "mfa_factor",
      targetId: current.id,
    });
    return { error: authMessages.mfaRejected };
  }

  await removeUnverifiedTotp(supabase, factors);
  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: "totp",
    friendlyName: "MediaIQ replacement",
    issuer: "MediaIQ",
  });

  if (error || data.type !== "totp") {
    return { error: authMessages.generic };
  }

  const recorded = await recordSecurityEvent({
    eventType: "auth.mfa.factor.replace_started",
    outcome: "success",
    metadata: { method: "totp" },
    targetType: "mfa_factor",
    targetId: data.id,
  });

  if (!recorded) {
    await supabase.auth.mfa.unenroll({ factorId: data.id });
    return { error: authMessages.auditFailed };
  }

  return {
    enrollment: {
      factorId: data.id,
      qrCode: data.totp.qr_code,
      secret: data.totp.secret,
      previousFactorId: current.id,
    },
  };
}

export async function finishFactorReplacement(
  _state: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const factorId = String(formData.get("factorId") ?? "");
  const previousFactorId = String(formData.get("previousFactorId") ?? "");
  const code = String(formData.get("code") ?? "").trim();
  const { supabase, userId } = await requireRecentMfa();
  const limited = await gate("mfa_verify", await accountsFor(supabase, userId));

  if (limited) {
    return limited;
  }
  const verified = await verifyTotp(supabase, factorId, code);

  if (!verified) {
    await supabase.auth.mfa.unenroll({ factorId });
    await recordSecurityEvent({
      eventType: "auth.mfa.challenge.failed",
      outcome: "failure",
      metadata: { method: "totp", purpose: "replace" },
      targetType: "mfa_factor",
      targetId: factorId,
    });
    return { error: authMessages.mfaRejected };
  }

  const { error } = await supabase.auth.mfa.unenroll({ factorId: previousFactorId });

  if (error) {
    await recordSecurityEvent({
      eventType: "auth.mfa.factor.remove_failed",
      outcome: "failure",
      metadata: { method: "totp", purpose: "replace" },
      targetType: "mfa_factor",
      targetId: previousFactorId,
    });
    return { error: authMessages.generic };
  }

  const recorded = await recordSecurityEvent({
    eventType: "auth.mfa.factor.removed",
    outcome: "success",
    metadata: { method: "totp", purpose: "replace" },
    targetType: "mfa_factor",
    targetId: previousFactorId,
  });

  if (!recorded) {
    return { error: authMessages.auditFailed };
  }

  redirect("/settings");
}

export async function removeVerifiedFactor(
  _state: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const factorId = String(formData.get("factorId") ?? "");
  const code = String(formData.get("code") ?? "").trim();
  const { supabase, userId } = await requireRecentMfa();
  const limited = await gate("mfa_verify", await accountsFor(supabase, userId));

  if (limited) {
    return limited;
  }
  const factors = await loadFactors(supabase);
  const verified = factors ? verifiedTotpFactors(factors) : [];
  const target = verified.find((factor) => factor.id === factorId);

  if (!target) {
    return { error: authMessages.generic };
  }

  if (!canRemoveVerifiedFactor(verified.length)) {
    await recordSecurityEvent({
      eventType: "auth.permission.denied",
      outcome: "denied",
      metadata: { action: "remove_last_mfa_factor" },
      targetType: "mfa_factor",
      targetId: factorId,
    });
    return { error: authMessages.lastFactor };
  }

  const confirmed = await verifyTotp(supabase, target.id, code);

  if (!confirmed) {
    await recordSecurityEvent({
      eventType: "auth.mfa.challenge.failed",
      outcome: "failure",
      metadata: { method: "totp", purpose: "remove" },
      targetType: "mfa_factor",
      targetId: factorId,
    });
    return { error: authMessages.mfaRejected };
  }

  const { error } = await supabase.auth.mfa.unenroll({ factorId });

  if (error) {
    return { error: authMessages.generic };
  }

  await recordSecurityEvent({
    eventType: "auth.mfa.factor.removed",
    outcome: "success",
    metadata: { method: "totp", purpose: "remove" },
    targetType: "mfa_factor",
    targetId: factorId,
  });
  redirect("/settings");
}
