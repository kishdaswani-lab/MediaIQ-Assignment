import "server-only";
import type { AuthSnapshot } from "../auth/session";
import {
  deleteEvidence,
  insertEvidence,
  listEvidence,
  readEvidence,
} from "./service";

export const deleteEvidenceConfirmation =
  "Delete this evidence permanently? This cannot be undone.";

export type EvidenceOperations = {
  insertEvidence: typeof insertEvidence;
  listEvidence: typeof listEvidence;
  readEvidence: typeof readEvidence;
  deleteEvidence: typeof deleteEvidence;
};

const realOperations: EvidenceOperations = {
  insertEvidence,
  listEvidence,
  readEvidence,
  deleteEvidence,
};

let sessionLoader = loadProtectedSession;
let operations = realOperations;

export function currentSession(): Promise<AuthSnapshot> {
  return sessionLoader();
}

export function evidenceOperations(): EvidenceOperations {
  return operations;
}

export function replaceEvidenceActionDependencies(next?: {
  session?: () => Promise<AuthSnapshot>;
  evidence?: Partial<EvidenceOperations>;
}): void {
  sessionLoader = next?.session ?? loadProtectedSession;
  operations = { ...realOperations, ...next?.evidence };
}

async function loadProtectedSession(): Promise<AuthSnapshot> {
  const { requireProtectedSession } = await import("../auth/session");
  return requireProtectedSession();
}
