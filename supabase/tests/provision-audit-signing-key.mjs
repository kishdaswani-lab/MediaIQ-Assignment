import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

// Local bootstrap for the generated audit signing key.
//
// Production provisioning:
// An operator with database-administrator access reads the active row from
// private.audit_signing_key and stores encode(secret, 'hex') in the platform
// secret manager as MEDIAIQ_AUDIT_SIGNING_KEY. Store key_id separately as
// MEDIAIQ_AUDIT_SIGNING_KEY_ID. Do not send the key through PostgREST, the
// writer role, application logs, or command-line arguments. The application
// must receive the new key before it starts signing with the new key id.
//
// Rotation:
// As mediaiq_security_maintainer, call private.rotate_audit_signing_key().
// It returns only the new key id. The previous key stays acceptable for at
// most 120 seconds, and an old signature is still rejected when its timestamp
// is outside the normal 60-second past / 5-second future window. After the
// overlap, the next trusted write or rotation deletes the retiring key.
// If the application signs with a key id the database does not accept, the
// trusted audit write fails closed and the authentication action fails closed.
// This script never overwrites a key that is already present.

const envPath = ".env.local";
const keyName = "MEDIAIQ_AUDIT_SIGNING_KEY";
const keyIdName = "MEDIAIQ_AUDIT_SIGNING_KEY_ID";

function readSetting(env, name) {
  const match = env.match(new RegExp(`^${name}=(.*)$`, "m"));
  return match ? match[1] : null;
}

function activeSigningKey() {
  let output = "";

  try {
    output = execFileSync(
      "docker",
      [
        "exec",
        "supabase_db_MediaIQ",
        "psql",
        "-U",
        "supabase_admin",
        "-d",
        "postgres",
        "-tA",
        "-c",
        "select key_id::text || ' ' || encode(secret, 'hex') from private.audit_signing_key where status = 'active'",
      ],
      { encoding: "utf8" },
    ).trim();
  } catch {
    throw new Error("signing key was not available");
  }

  const match = output.match(/^(\d+) ([0-9a-f]{64})$/);

  if (!match || Number(match[1]) > 32767) {
    throw new Error("signing key was not available");
  }

  return { keyId: match[1], keyHex: match[2] };
}

const env = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
const existingKey = readSetting(env, keyName);
const existingKeyId = readSetting(env, keyIdName);
const active = activeSigningKey();

if ((existingKey === null) !== (existingKeyId === null)) {
  throw new Error("signing key configuration is incomplete");
}

if (existingKey !== null || existingKeyId !== null) {
  if (existingKey !== active.keyHex || existingKeyId !== active.keyId) {
    throw new Error("signing key does not match the active database key");
  }

  console.log("signing key already provisioned");
} else {
  const suffix = env.length === 0 || env.endsWith("\n") ? "" : "\n";
  writeFileSync(
    envPath,
    `${env}${suffix}${keyIdName}=${active.keyId}\n${keyName}=${active.keyHex}\n`,
  );
  console.log("signing key provisioned");
}
