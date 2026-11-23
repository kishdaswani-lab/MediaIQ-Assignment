import "server-only";
import {
  dispatchValidatedRequest,
  ensurePerformanceSummary,
  openEvidenceQuestion,
  listEligibleUnknownReservations,
  readMiaContext,
  reconcileUnknownReservation,
} from "./service";

export type MiaOperations = {
  ensurePerformanceSummary: typeof ensurePerformanceSummary;
  openEvidenceQuestion: typeof openEvidenceQuestion;
  dispatchValidatedRequest: typeof dispatchValidatedRequest;
  listEligibleUnknownReservations: typeof listEligibleUnknownReservations;
  readMiaContext: typeof readMiaContext;
  reconcileUnknownReservation: typeof reconcileUnknownReservation;
};

const realOperations: MiaOperations = {
  ensurePerformanceSummary,
  openEvidenceQuestion,
  dispatchValidatedRequest,
  listEligibleUnknownReservations,
  readMiaContext,
  reconcileUnknownReservation,
};

let operations = realOperations;

export function miaOperations(): MiaOperations {
  return operations;
}

export function replaceMiaOperations(next?: Partial<MiaOperations>): void {
  operations = { ...realOperations, ...next };
}
