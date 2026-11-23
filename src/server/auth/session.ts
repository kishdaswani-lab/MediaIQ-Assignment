import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/utils/supabase/server";
import {
  accessDecision,
  type Assurance,
  type AuthContext,
} from "@/server/auth/policy";

export async function createSupabase(): Promise<SupabaseClient> {
  return createClient(await cookies());
}

export type AuthSnapshot = {
  userId: string;
  email: string;
  emailConfirmed: boolean;
  assurance: Assurance;
  verifiedTotp: boolean;
};

function assuranceFromClaims(aal: unknown): Assurance {
  return aal === "aal2" ? "aal2" : "aal1";
}

export async function readAuthSnapshot(): Promise<AuthSnapshot | null> {
  const supabase = await createSupabase();
  const { data, error } = await supabase.auth.getClaims();

  if (error || !data?.claims?.sub) {
    return null;
  }

  const { data: userData, error: userError } = await supabase.auth.getUser();

  if (userError || !userData.user) {
    return null;
  }

  const verifiedTotp = (userData.user.factors ?? []).some(
    (factor) => factor.factor_type === "totp" && factor.status === "verified",
  );

  return {
    userId: userData.user.id,
    email: userData.user.email ?? "",
    emailConfirmed: userData.user.email_confirmed_at != null,
    assurance: assuranceFromClaims(data.claims.aal),
    verifiedTotp,
  };
}

export function contextFromSnapshot(snapshot: AuthSnapshot | null): AuthContext {
  if (!snapshot) {
    return {
      hasSession: false,
      emailConfirmed: false,
      assurance: null,
      verifiedTotp: false,
    };
  }

  return {
    hasSession: true,
    emailConfirmed: snapshot.emailConfirmed,
    assurance: snapshot.assurance,
    verifiedTotp: snapshot.verifiedTotp,
  };
}

export async function requireProtectedSession(): Promise<AuthSnapshot> {
  const snapshot = await readAuthSnapshot();
  const decision = accessDecision(contextFromSnapshot(snapshot), "/");

  if (!decision.allow) {
    redirect(decision.redirectTo ?? "/login");
  }

  return snapshot as AuthSnapshot;
}

export async function requireAuthPage(
  pathname: "/login" | "/signup" | "/forgot-password" | "/mfa/enroll" | "/mfa/verify",
  requestedNext?: string | null,
): Promise<AuthSnapshot | null> {
  const snapshot = await readAuthSnapshot();
  const decision = accessDecision(
    contextFromSnapshot(snapshot),
    pathname,
    requestedNext,
  );

  if (!decision.allow) {
    redirect(decision.redirectTo ?? "/login");
  }

  return snapshot;
}
