import { execFileSync } from "node:child_process";
import postgres from "postgres";

const writerPassword = execFileSync(
  "docker",
  [
    "exec",
    "supabase_db_MediaIQ",
    "psql",
    "-U",
    "postgres",
    "-d",
    "postgres",
    "-tA",
    "-c",
    "select value from private.security_secrets where name = 'writer_password'",
  ],
  { encoding: "utf8" },
).trim();

const sql = postgres({
  host: "127.0.0.1",
  port: 54322,
  database: "postgres",
  username: "mediaiq_security_writer",
  password: writerPassword,
  prepare: false,
  max: 20,
});

const adminQuery = (statement) =>
  execFileSync(
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
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      statement,
    ],
    { encoding: "utf8" },
  ).trim();

const before = Number(
  adminQuery(
    "select coalesce(max(attempt_count), 0) from private.security_counters where action = 'password_update' and dimension = 'global' and identity_hash = 'global'",
  ),
);

try {
  await sql`set role mediaiq_security_owner`;
  throw new Error("writer assumed the owner role");
} catch (error) {
  if (error instanceof Error && error.message === "writer assumed the owner role") {
    throw error;
  }
}

const results = await Promise.all(
  Array.from({ length: 20 }, () =>
    sql`select private.consume_auth_throttle('password_update', 'local', array[]::text[]) as result`,
  ),
);

const denied = results.filter((row) => row[0]?.result?.allowed !== true).length;
const after = Number(
  adminQuery(
    "select coalesce(max(attempt_count), 0) from private.security_counters where action = 'password_update' and dimension = 'global' and identity_hash = 'global'",
  ),
);

adminQuery(
  "delete from private.security_counters where action = 'password_update' and dimension = 'global' and identity_hash = 'global' and attempt_count = " +
    after,
);

if (before > 0) {
  adminQuery(
    "insert into private.security_counters (action, dimension, identity_hash, window_started, last_attempt, attempt_count, delay_seconds) values ('password_update', 'global', 'global', now(), now(), " +
      before +
      ", 0)",
  );
}

adminQuery(
  "delete from private.security_counters where action = 'password_update' and dimension = 'client' and identity_hash = 'local'",
);

await sql.end();

if (denied !== 0 || after - before !== 20) {
  console.log(`concurrency failed denied=${denied} delta=${after - before}`);
  process.exit(1);
}

console.log("concurrency passed");
