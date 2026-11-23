import "server-only";
import postgres from "postgres";

const configuredMessage = "evidence writer is not configured";
const productionMessage = "evidence writer production connections are not approved";
const serverOnlyMessage = "evidence writer is server only";

export const evidencePoolGlobalKey = "mediaiqEvidenceSql";

type EvidenceSql = ReturnType<typeof postgres>;

const globalForEvidence = globalThis as typeof globalThis & {
  mediaiqEvidenceSql?: EvidenceSql;
};

assertEvidencePoolServer();

export function assertEvidencePoolServer(): void {
  if (typeof window !== "undefined") {
    throw new Error(serverOnlyMessage);
  }
}

export function evidenceSql(): EvidenceSql {
  assertEvidencePoolServer();

  if (hostedEvidenceConnectionsBlocked()) {
    throw new Error(productionMessage);
  }

  const connection = process.env.MEDIAIQ_EVIDENCE_DATABASE_URL;

  if (!connection) {
    throw new Error(configuredMessage);
  }

  if (!globalForEvidence.mediaiqEvidenceSql) {
    globalForEvidence.mediaiqEvidenceSql = postgres(connection, {
      prepare: false,
      // Local development only. One connection in this process does not keep
      // concurrent instances inside the role ceiling of 8.
      max: 1,
      idle_timeout: 20,
      connect_timeout: 5,
      onnotice: false,
    });
  }

  return globalForEvidence.mediaiqEvidenceSql;
}

function hostedEvidenceConnectionsBlocked(): boolean {
  return (
    process.env.NODE_ENV === "production" ||
    process.env.VERCEL_ENV === "production" ||
    process.env.VERCEL_ENV === "preview"
  );
}
