"use server";

import "server-only";
import { randomUUID } from "node:crypto";
import { currentSession, evidenceOperations } from "@/server/evidence/action-dependencies";
import type { EvidenceDetail } from "@/server/evidence/service";
import { miaOperations } from "./dependencies";
import { miaQuestionOctets, MIA_QUESTION_MAX_OCTETS } from "./fingerprint";
import { MiaServiceError, reservationReleaseReason, type EligibleReservation, type MiaContext, type MiaQuestionRecord, type MiaRequestRecord, type ReservationReconciliation } from "./service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const invalidRequestMessage = "The MIA request is not valid.";
const notFoundMessage = "The evidence was not found.";
const unavailableMessage = "The MIA request could not be completed.";

export type MiaActionFailure = {
  ok: false;
  kind: "validation" | "not_found" | "conflict" | "unavailable";
  message: string;
};

export type InitializeMiaSummaryResult =
  | { ok: true; evidenceSaved: true; request: MiaRequestRecord }
  | MiaActionFailure;

export type AskMiaQuestionResult =
  | { ok: true; evidenceSaved: true; request: MiaQuestionRecord; exchange: MiaContext["exchange"] }
  | MiaActionFailure;

export type ReadMiaContextResult =
  | { ok: true; context: MiaContext }
  | MiaActionFailure;

export type ReconcileMiaReservationResult =
  | ({ ok: true; reasonCode: typeof reservationReleaseReason } & ReservationReconciliation)
  | MiaActionFailure;

export async function initializeMiaSummaryAction(input: unknown): Promise<InitializeMiaSummaryResult> {
  const snapshot = await currentSession();
  const evidenceId = evidenceIdFrom(input);
  if (!evidenceId) {
    return validation(invalidRequestMessage);
  }

  try {
    const evidence = await evidenceOperations().readEvidence(snapshot.userId, evidenceId);
    if (!evidence) {
      return notFound();
    }
    const request = await miaOperations().ensurePerformanceSummary(snapshot.userId, evidenceIdentity(evidence));
    return { ok: true, evidenceSaved: true, request };
  } catch (error) {
    return serviceFailure(error);
  }
}

export async function generateMiaSummaryAction(input: unknown): Promise<InitializeMiaSummaryResult> {
  const snapshot = await currentSession();
  const evidenceId = evidenceIdFrom(input);
  if (!evidenceId) {
    return validation(invalidRequestMessage);
  }

  try {
    const evidence = await evidenceOperations().readEvidence(snapshot.userId, evidenceId);
    if (!evidence) {
      return notFound();
    }
    const identity = evidenceIdentity(evidence);
    const opened = await miaOperations().ensurePerformanceSummary(snapshot.userId, identity);
    const request = opened.state === "validating"
      ? await miaOperations().dispatchValidatedRequest(snapshot.userId, identity, opened, null)
      : opened;
    return { ok: true, evidenceSaved: true, request };
  } catch (error) {
    return serviceFailure(error);
  }
}

export async function askMiaQuestionAction(input: unknown): Promise<AskMiaQuestionResult> {
  const snapshot = await currentSession();
  const evidenceId = evidenceIdFrom(input);
  const question = questionFrom(input);
  const idempotencyKey = idempotencyKeyFrom(input);
  if (!evidenceId || question === undefined || idempotencyKey === undefined) {
    return validation(invalidRequestMessage);
  }
  if (question.length === 0 || miaQuestionOctets(question) > MIA_QUESTION_MAX_OCTETS) {
    return validation(question.length === 0 ? "Enter a question." : "The question is too long.");
  }

  try {
    const evidence = await evidenceOperations().readEvidence(snapshot.userId, evidenceId);
    if (!evidence) {
      return notFound();
    }
    const opened = await miaOperations().openEvidenceQuestion(
      snapshot.userId,
      evidenceIdentity(evidence),
      question,
      idempotencyKey ?? randomUUID(),
    );
    const request = opened.state === "validating" && opened.availability !== "refused"
      ? await miaOperations().dispatchValidatedRequest(snapshot.userId, evidenceIdentity(evidence), opened, question)
      : opened;
    const context = await miaOperations().readMiaContext(snapshot.userId, evidence.id);
    return {
      ok: true,
      evidenceSaved: true,
      request,
      exchange: context?.exchange ?? { question: null, answer: null, exchangedAt: null },
    };
  } catch (error) {
    return serviceFailure(error);
  }
}

export type ListEligibleReservationsResult =
  | { ok: true; reservations: EligibleReservation[] }
  | MiaActionFailure;

export async function listEligibleReservationsAction(): Promise<ListEligibleReservationsResult> {
  const snapshot = await currentSession();

  try {
    const reservations = await miaOperations().listEligibleUnknownReservations(snapshot.userId);
    return { ok: true, reservations };
  } catch (error) {
    return serviceFailure(error);
  }
}

export async function reconcileMiaReservationAction(input: unknown): Promise<ReconcileMiaReservationResult> {
  const snapshot = await currentSession();
  const requestId = requestIdFrom(input);
  const phpAmount = positiveDecimal(input, "phpAmount");
  const usdAmount = positiveDecimal(input, "usdAmount");
  if (!requestId || !phpAmount || !usdAmount) {
    return validation(invalidRequestMessage);
  }

  try {
    const reconciliation = await miaOperations().reconcileUnknownReservation(
      snapshot.userId,
      requestId,
      phpAmount,
      usdAmount,
    );
    return { ok: true, reasonCode: reservationReleaseReason, ...reconciliation };
  } catch (error) {
    return serviceFailure(error);
  }
}

export async function readMiaContextAction(input: unknown): Promise<ReadMiaContextResult> {
  const snapshot = await currentSession();
  const evidenceId = evidenceIdFrom(input);
  if (!evidenceId) {
    return validation(invalidRequestMessage);
  }

  try {
    const context = await miaOperations().readMiaContext(snapshot.userId, evidenceId);
    if (!context) {
      return notFound();
    }
    return { ok: true, context };
  } catch (error) {
    return serviceFailure(error);
  }
}

function evidenceIdentity(evidence: EvidenceDetail) {
  return {
    id: evidence.id,
    parserVersion: evidence.parserVersion,
    calculationVersion: evidence.calculationVersion,
    summary: evidence.summary,
  };
}

function requestIdFrom(input: unknown): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const requestId = (input as { requestId?: unknown }).requestId;
  if (typeof requestId !== "string" || !UUID.test(requestId)) {
    return null;
  }
  return requestId.toLowerCase();
}

function positiveDecimal(input: unknown, key: "phpAmount" | "usdAmount"): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const value = (input as { phpAmount?: unknown; usdAmount?: unknown })[key];
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) {
    return null;
  }
  if (/^0+(?:\.0+)?$/.test(value)) {
    return null;
  }
  return value;
}

function evidenceIdFrom(input: unknown): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const evidenceId = (input as { evidenceId?: unknown }).evidenceId;
  if (typeof evidenceId !== "string" || !UUID.test(evidenceId)) {
    return null;
  }
  return evidenceId.toLowerCase();
}

function questionFrom(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const question = (input as { question?: unknown }).question;
  return typeof question === "string" ? question : undefined;
}

function idempotencyKeyFrom(input: unknown): string | null | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const key = (input as { idempotencyKey?: unknown }).idempotencyKey;
  if (key == null) {
    return null;
  }
  if (typeof key !== "string" || Buffer.byteLength(key, "utf8") < 1 || Buffer.byteLength(key, "utf8") > 200) {
    return undefined;
  }
  return key;
}

function validation(message: string): MiaActionFailure {
  return { ok: false, kind: "validation", message };
}

function notFound(): MiaActionFailure {
  return { ok: false, kind: "not_found", message: notFoundMessage };
}

function serviceFailure(error: unknown): MiaActionFailure {
  if (error instanceof MiaServiceError) {
    if (error.kind === "not_found") {
      return { ok: false, kind: "not_found", message: error.message };
    }
    if (error.kind === "conflict") {
      return { ok: false, kind: "conflict", message: error.message };
    }
    if (error.kind === "invalid") {
      return { ok: false, kind: "validation", message: error.message };
    }
  }
  return { ok: false, kind: "unavailable", message: unavailableMessage };
}
