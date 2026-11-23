import "server-only";
import { currentSession, evidenceOperations } from "@/server/evidence/action-dependencies";
import type { EvidenceSummary } from "@/server/evidence/types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type MiaEvidenceRead =
  | { ok: true; evidenceId: string; summary: EvidenceSummary }
  | { ok: false; kind: "invalid" | "not_found" };

export async function readMiaEvidence(evidenceId: string): Promise<MiaEvidenceRead> {
  if (!UUID.test(evidenceId)) {
    return { ok: false, kind: "invalid" };
  }
  const snapshot = await currentSession();
  const evidence = await evidenceOperations().readEvidence(snapshot.userId, evidenceId.toLowerCase());
  if (!evidence) {
    return { ok: false, kind: "not_found" };
  }
  return { ok: true, evidenceId: evidence.id, summary: evidence.summary };
}
