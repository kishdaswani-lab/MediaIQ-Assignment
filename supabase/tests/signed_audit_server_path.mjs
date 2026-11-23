import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import postgres from "postgres";
import {
  canonicalAuditPayload,
  issuedMicrosFromEpochMilliseconds,
  signAuditPayload,
} from "../../src/server/auth/audit-signature.ts";

function readSetting(name) {
  const env = readFileSync(".env.local", "utf8");
  const match = env.match(new RegExp(`^${name}=(.*)$`, "m"));

  if (!match || match[1].length === 0) {
    throw new Error(`${name} is not provisioned`);
  }

  return match[1];
}

function sqlState(error) {
  return error && typeof error === "object" && "code" in error ? String(error.code) : "unknown";
}

const actorId = "88888888-8888-4888-8888-888888888888";
const eventId = randomUUID();
const keyId = Number(readSetting("MEDIAIQ_AUDIT_SIGNING_KEY_ID"));
const keyHex = readSetting("MEDIAIQ_AUDIT_SIGNING_KEY");
const epochMilliseconds = Date.now();
const metadata = { method: "password" };
const context = {
  aal: "aal1",
  method: "password",
  session_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
};
const payload = canonicalAuditPayload({
  keyId,
  eventId,
  operation: "login_succeeded",
  actorId,
  issuedMicros: issuedMicrosFromEpochMilliseconds(epochMilliseconds),
  metadata,
  context,
});
const signature = signAuditPayload(payload, keyHex);
const sql = postgres(readSetting("MEDIAIQ_SECURITY_DATABASE_URL"), {
  prepare: false,
  max: 1,
  connect_timeout: 5,
});

async function removeEvent() {
  const cleanup = `
    begin;
    select set_config('role', 'mediaiq_security_owner', true);
    select set_config('mediaiq.audit_maintenance', 'on', true);
    delete from public.audit_events where id = '${eventId}'::uuid;
    commit;
  `;

  execFileSync(
    "docker",
    ["exec", "-i", "supabase_db_MediaIQ", "psql", "-U", "supabase_admin", "-d", "postgres", "-v", "ON_ERROR_STOP=1"],
    { input: cleanup, encoding: "utf8" },
  );
}

try {
  await sql`
    select private.record_trusted_auth_event(
      ${eventId}::uuid,
      ${keyId}::smallint,
      'login_succeeded',
      ${actorId}::uuid,
      ${new Date(epochMilliseconds).toISOString()}::timestamptz,
      ${sql.json(metadata)}::jsonb,
      ${sql.json(context)}::jsonb,
      ${signature}
    )
  `;

  const recorded = execFileSync(
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
      `select actor_user_id::text || ' ' || event_type || ' ' || outcome from public.audit_events where id = '${eventId}'::uuid`,
    ],
    { encoding: "utf8" },
  ).trim();

  if (recorded !== `${actorId} auth.login.succeeded success`) {
    throw new Error("signed server path did not record the verified actor");
  }

  const tampered = canonicalAuditPayload({
    keyId,
    eventId: randomUUID(),
    operation: "login_succeeded",
    actorId: "99999999-9999-4999-8999-999999999999",
    issuedMicros: issuedMicrosFromEpochMilliseconds(epochMilliseconds),
    metadata,
    context,
  });

  try {
    await sql`
      select private.record_trusted_auth_event(
        ${randomUUID()}::uuid,
        ${keyId}::smallint,
        'login_succeeded',
        ${actorId}::uuid,
        ${new Date(epochMilliseconds).toISOString()}::timestamptz,
        ${sql.json(metadata)}::jsonb,
        ${sql.json(context)}::jsonb,
        ${signAuditPayload(tampered, keyHex)}
      )
    `;
    throw new Error("changed actor was accepted");
  } catch (error) {
    if (sqlState(error) !== "42501") {
      throw new Error(`changed actor returned ${sqlState(error)}`);
    }
  }

  console.log("signed server path recorded the verified actor");
} finally {
  await sql.end();
  await removeEvent();
}
