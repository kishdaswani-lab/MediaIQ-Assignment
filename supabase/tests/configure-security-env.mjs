import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const envPath = ".env.local";
let env = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";

if (!env.includes("MEDIAIQ_SECURITY_DATABASE_URL=")) {
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

  if (!/^[0-9a-f]{48}$/.test(writerPassword)) {
    throw new Error("writer secret was not available");
  }

  env += `${env.endsWith("\n") || env.length === 0 ? "" : "\n"}MEDIAIQ_SECURITY_DATABASE_URL=postgresql://mediaiq_security_writer:${writerPassword}@127.0.0.1:54322/postgres\n`;
}

if (!env.includes("MEDIAIQ_RATE_LIMIT_PEPPER=")) {
  env += `MEDIAIQ_RATE_LIMIT_PEPPER=${randomBytes(32).toString("hex")}\n`;
}

writeFileSync(envPath, env);
console.log("security env ready");
