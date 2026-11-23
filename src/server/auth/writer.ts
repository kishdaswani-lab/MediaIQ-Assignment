import postgres from "postgres";

type SecuritySql = ReturnType<typeof postgres>;

const globalForSecurity = globalThis as unknown as {
  mediaiqSecuritySql?: SecuritySql;
};

export function securitySql(): SecuritySql {
  const connection = process.env.MEDIAIQ_SECURITY_DATABASE_URL;

  if (!connection) {
    throw new Error("security writer is not configured");
  }

  if (!globalForSecurity.mediaiqSecuritySql) {
    globalForSecurity.mediaiqSecuritySql = postgres(connection, {
      prepare: false,
      max: 5,
      idle_timeout: 20,
      connect_timeout: 5,
    });
  }

  return globalForSecurity.mediaiqSecuritySql;
}
