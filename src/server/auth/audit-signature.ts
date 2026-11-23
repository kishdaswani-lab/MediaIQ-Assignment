import { createHmac } from "node:crypto";

const keyPattern = /^[a-z0-9_]+$/;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const allowedMethods = new Set([
  "password",
  "totp",
  "recovery",
  "otp",
  "email/signup",
]);

export type AuditClaims = {
  sub?: unknown;
  aal?: unknown;
  session_id?: unknown;
  amr?: unknown;
};

export type AuditContext = {
  aal: "aal1" | "aal2";
  method: string;
  session_id: string;
};

function jsonString(value: string): string {
  const normalized = value.normalize("NFC");
  let encoded = '"';

  for (const character of normalized) {
    const code = character.codePointAt(0) ?? 0;

    if (code === 34) {
      encoded += '\\"';
    } else if (code === 92) {
      encoded += "\\\\";
    } else if (code < 32) {
      encoded += `\\u00${code.toString(16).padStart(2, "0")}`;
    } else {
      encoded += character;
    }
  }

  return `${encoded}"`;
}

export function canonicalJson(value: Record<string, string | boolean>): string {
  const keys = Object.keys(value);

  for (const key of keys) {
    const item = value[key];

    if (!keyPattern.test(key) || (typeof item !== "string" && typeof item !== "boolean")) {
      throw new Error("metadata is not allowed");
    }
  }

  keys.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));

  return `{${keys
    .map((key) => {
      const item = value[key];
      return `"${key}":${typeof item === "boolean" ? (item ? "true" : "false") : jsonString(item ?? "")}`;
    })
    .join(",")}}`;
}

export function issuedMicrosFromEpochMilliseconds(epochMilliseconds: number): bigint {
  if (!Number.isSafeInteger(epochMilliseconds)) {
    throw new Error("timestamp is not valid");
  }

  return BigInt(epochMilliseconds) * BigInt(1000);
}

export function canonicalAuditPayload(input: {
  keyId: number;
  eventId: string;
  operation: string;
  actorId: string;
  issuedMicros: bigint;
  metadata: Record<string, string | boolean>;
  context: Record<string, string | boolean>;
}): string {
  return [
    "mediaiq-audit-v1",
    String(input.keyId),
    input.eventId,
    input.operation,
    input.actorId,
    input.issuedMicros.toString(),
    canonicalJson(input.metadata),
    canonicalJson(input.context),
  ].join("\n");
}

export function signAuditPayload(payload: string, keyHex: string): string {
  if (!/^[0-9a-f]{64}$/.test(keyHex)) {
    throw new Error("signing key is not valid");
  }

  return createHmac("sha256", Buffer.from(keyHex, "hex")).update(payload, "utf8").digest("hex");
}

function normalizeUuid(value: unknown): string | null {
  if (typeof value !== "string" || !uuidPattern.test(value.toLowerCase())) {
    return null;
  }

  return value.toLowerCase();
}

function methodFromAmr(amr: unknown): string | null {
  if (!Array.isArray(amr) || amr.length === 0) {
    return null;
  }

  if (amr.every((entry) => typeof entry === "string")) {
    const method = amr[amr.length - 1];
    return typeof method === "string" && allowedMethods.has(method) ? method : null;
  }

  if (
    !amr.every(
      (entry) => entry !== null && typeof entry === "object" && !Array.isArray(entry),
    )
  ) {
    return null;
  }

  let selected: { method: string; timestamp: number; index: number } | null = null;

  for (const [index, entry] of amr.entries()) {
    const method = (entry as { method?: unknown }).method;
    const timestamp = (entry as { timestamp?: unknown }).timestamp;

    if (typeof method !== "string" || !allowedMethods.has(method)) {
      return null;
    }

    if (typeof timestamp !== "number" || !Number.isSafeInteger(timestamp)) {
      return null;
    }

    if (
      selected === null ||
      timestamp > selected.timestamp ||
      (timestamp === selected.timestamp && index > selected.index)
    ) {
      selected = { method, timestamp, index };
    }
  }

  return selected?.method ?? null;
}

export function authContextFromClaims(
  claims: AuditClaims,
): { actorId: string; context: AuditContext } | null {
  const actorId = normalizeUuid(claims.sub);
  const sessionId = normalizeUuid(claims.session_id);
  const method = methodFromAmr(claims.amr);

  if (!actorId || !sessionId || (claims.aal !== "aal1" && claims.aal !== "aal2") || !method) {
    return null;
  }

  if (method === "email/signup" && claims.aal !== "aal1") {
    return null;
  }

  return {
    actorId,
    context: {
      aal: claims.aal,
      method,
      session_id: sessionId,
    },
  };
}
