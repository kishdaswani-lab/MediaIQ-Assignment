import { createHmac, randomUUID } from "node:crypto";
import { headers } from "next/headers";
import {
  authContextFromClaims,
  canonicalAuditPayload,
  issuedMicrosFromEpochMilliseconds,
  signAuditPayload,
} from "@/server/auth/audit-signature";
import { clientRateLimitIdentity, isVercelDeployment } from "@/server/auth/policy";
import { createSupabase } from "@/server/auth/session";
import { securitySql } from "@/server/auth/writer";

type SecurityOutcome = "success" | "failure" | "denied";

type SecurityEvent = {
  eventType: string;
  outcome: SecurityOutcome;
  metadata?: Record<string, unknown>;
  targetType?: string;
  targetId?: string;
};

type AttemptGate = {
  allowed: boolean;
  retryAfterSeconds: number;
};

const trustedOperations: Record<string, { operation: string; outcome: SecurityOutcome }> = {
  "auth.login.succeeded": { operation: "login_succeeded", outcome: "success" },
  "auth.logout": { operation: "logout", outcome: "success" },
  "auth.signup.succeeded": { operation: "signup_succeeded", outcome: "success" },
  "auth.password_reset.completed": { operation: "password_changed", outcome: "success" },
  "auth.password_change.failed": { operation: "password_change_failed", outcome: "failure" },
  "auth.mfa.enroll.started": { operation: "mfa_enroll_started", outcome: "success" },
  "auth.mfa.enroll.failed": { operation: "mfa_enroll_failed", outcome: "failure" },
  "auth.mfa.enroll.verified": { operation: "mfa_enroll_verified", outcome: "success" },
  "auth.mfa.challenge.verified": { operation: "mfa_verified", outcome: "success" },
  "auth.mfa.challenge.failed": { operation: "mfa_challenge_failed", outcome: "failure" },
  "auth.mfa.factor.removed": { operation: "mfa_factor_removed", outcome: "success" },
  "auth.mfa.factor.remove_failed": { operation: "mfa_factor_remove_failed", outcome: "failure" },
  "auth.mfa.factor.replace_started": { operation: "mfa_factor_replace_started", outcome: "success" },
  "auth.session.revoked": { operation: "session_revoked", outcome: "success" },
  "auth.permission.denied": { operation: "authorization_denied", outcome: "denied" },
};

const telemetryOperations: Record<string, string> = {
  "auth.login.failed": "login_failed",
  "auth.signup.rejected": "signup_rejected",
  "auth.signup.requested": "signup_requested",
  "auth.password_reset.requested": "password_recovery_requested",
  "auth.rate_limited": "rate_limited",
  "auth.session.rejected": "invalid_session",
};

const resetOperations = new Set([
  "mfa_enroll_verified",
  "mfa_verified",
  "mfa_factor_removed",
  "mfa_factor_replace_started",
]);

export async function requestSubject(): Promise<{ ip: string | null; userAgent: string }> {
  const headerStore = await headers();

  return {
    ip: clientRateLimitIdentity({
      vercel: isVercelDeployment({
        vercel: process.env.VERCEL,
        vercelEnv: process.env.VERCEL_ENV,
      }),
      trustedForwardedFor: headerStore.get("x-vercel-forwarded-for"),
    }),
    userAgent: (headerStore.get("user-agent") ?? "").slice(0, 300),
  };
}

function accountHash(value: string): string | null {
  const pepper = process.env.MEDIAIQ_RATE_LIMIT_PEPPER;
  const normalized = value.normalize("NFKC").trim().toLowerCase();

  if (!pepper || !normalized) {
    return null;
  }

  return createHmac("sha256", pepper).update(normalized).digest("hex");
}

export async function consumeSecurityAttempt(
  action: string,
  accounts: string[] = [],
): Promise<AttemptGate> {
  const hashes = accounts.map(accountHash);
  const { ip } = await requestSubject();

  if (!ip || hashes.some((hash) => hash === null)) {
    return { allowed: false, retryAfterSeconds: 60 };
  }

  try {
    const sql = securitySql();
    const rows = await sql<{ result: { allowed?: boolean; retry_after_seconds?: number } }[]>`
      select private.consume_auth_throttle(
        ${action},
        ${ip},
        ${hashes as string[]}::text[]
      ) as result
    `;
    const result = rows[0]?.result;

    if (!result) {
      return { allowed: false, retryAfterSeconds: 60 };
    }

    return {
      allowed: result.allowed === true,
      retryAfterSeconds:
        typeof result.retry_after_seconds === "number" ? result.retry_after_seconds : 60,
    };
  } catch {
    return { allowed: false, retryAfterSeconds: 60 };
  }
}

export async function recordSecurityEvent(event: SecurityEvent): Promise<boolean> {
  const metadata = event.metadata ?? {};
  const telemetryOperation = telemetryOperations[event.eventType];
  const trusted = trustedOperations[event.eventType];
  const { userAgent } = await requestSubject();

  if (!event.outcome || (telemetryOperation && trusted)) {
    return false;
  }

  try {
    const sql = securitySql();

    if (telemetryOperation) {
      await sql`
        select private.record_auth_telemetry(
          ${telemetryOperation},
          ${sql.json(metadata)},
          ${userAgent}
        )
      `;
      return true;
    }

    if (!trusted || event.outcome !== trusted.outcome) {
      return false;
    }

    const supabase = await createSupabase();
    const { data: claimsData, error: claimsError } = await supabase.auth.getClaims();
    const verified = claimsError ? null : authContextFromClaims(claimsData?.claims ?? {});

    if (!verified) {
      return false;
    }

    const { data } = await supabase.auth.getUser();
    const email = data.user?.email ?? "";
    const identifiers = [verified.actorId, email].filter((value) => value.length > 0);
    const signedMetadata: Record<string, string | boolean> = {};

    for (const [key, value] of Object.entries(metadata)) {
      if (key === "account_hashes" || (typeof value !== "string" && typeof value !== "boolean")) {
        return false;
      }

      signedMetadata[key] = value;
    }

    if (resetOperations.has(trusted.operation)) {
      const resetHashes = identifiers.map(accountHash);

      if (resetHashes.some((hash) => hash === null)) {
        return false;
      }

      const hashes = resetHashes.filter((hash): hash is string => hash !== null);

      if (hashes.length > 0) {
        signedMetadata.account_hashes = hashes.slice(0, 2).join(",");
      }
    }

    const keyHex = process.env.MEDIAIQ_AUDIT_SIGNING_KEY ?? "";
    const keyId = Number(process.env.MEDIAIQ_AUDIT_SIGNING_KEY_ID);

    if (!Number.isSafeInteger(keyId) || keyId < 0 || keyId > 32767) {
      return false;
    }

    const epochMilliseconds = Date.now();
    const eventId = randomUUID();
    const payload = canonicalAuditPayload({
      keyId,
      eventId,
      operation: trusted.operation,
      actorId: verified.actorId,
      issuedMicros: issuedMicrosFromEpochMilliseconds(epochMilliseconds),
      metadata: signedMetadata,
      context: verified.context,
    });
    const signature = signAuditPayload(payload, keyHex);

    await sql`
      select private.record_trusted_auth_event(
        ${eventId}::uuid,
        ${keyId}::smallint,
        ${trusted.operation},
        ${verified.actorId}::uuid,
        ${new Date(epochMilliseconds).toISOString()}::timestamptz,
        ${sql.json(signedMetadata)}::jsonb,
        ${sql.json(verified.context)}::jsonb,
        ${signature}
      )
    `;
    return true;
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;

    return code === "23505";
  }
}
