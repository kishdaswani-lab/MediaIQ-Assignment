"use server";

import "server-only";
import { parseCampaignCsv } from "./parse-campaign-csv";
import { calculateEvidence } from "./calculate-evidence";
import { miaOperations } from "@/server/mia/dependencies";
import type { MiaRequestRecord } from "@/server/mia/service";
import {
  currentSession,
  deleteEvidenceConfirmation,
  evidenceOperations,
} from "./action-dependencies";
import {
  evidenceUnavailableMessage,
  EvidenceServiceError,
  type EvidenceCursor,
  type EvidenceDetail,
  type EvidenceListItem,
} from "./service";
import { MAX_CSV_BYTES, type EvidenceErrorCode } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const notFoundMessage = "The evidence was not found.";
const invalidRequestMessage = "The evidence request is not valid.";
const invalidPageMessage = "The evidence page is not valid.";

export type EvidenceActionFailure = {
  ok: false;
  kind: "validation" | "not_found" | "unavailable" | "unconfirmed";
  message: string;
  code?: EvidenceErrorCode;
};

export type UploadMiaState =
  | { initialized: true; request: MiaRequestRecord }
  | { initialized: false; message: string };

export type UploadEvidenceResult =
  | { ok: true; evidence: EvidenceDetail; mia: UploadMiaState }
  | EvidenceActionFailure;

const summaryNotStartedMessage =
  "The evidence was saved. The MIA summary could not be started. You can try the summary again.";
export type ListEvidenceResult = { ok: true; evidence: EvidenceListItem[] } | EvidenceActionFailure;
export type ReadEvidenceResult = { ok: true; evidence: EvidenceDetail } | EvidenceActionFailure;
export type DeleteEvidenceResult = { ok: true } | EvidenceActionFailure;

export async function uploadEvidenceAction(formData: FormData): Promise<UploadEvidenceResult> {
  const snapshot = await currentSession();
  if (!(formData instanceof FormData)) {
    return validation("Choose a CSV file.");
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return validation("Choose a CSV file.");
  }
  if (file.size > MAX_CSV_BYTES) {
    return validation("The file is larger than 1 MiB.", "file_too_large");
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength > MAX_CSV_BYTES) {
    return validation("The file is larger than 1 MiB.", "file_too_large");
  }

  const currencyValue = formData.get("currency");
  const parsed = parseCampaignCsv(
    bytes,
    typeof currencyValue === "string" ? { currency: currencyValue } : {},
  );
  if (!parsed.ok) {
    return validation(parsed.message, parsed.code);
  }

  const summary = calculateEvidence(parsed);
  try {
    const evidence = await evidenceOperations().insertEvidence(
      snapshot.userId,
      parsed.sourceText,
      summary,
    );
    try {
      const request = await miaOperations().ensurePerformanceSummary(snapshot.userId, {
        id: evidence.id,
        parserVersion: evidence.parserVersion,
        calculationVersion: evidence.calculationVersion,
        summary: evidence.summary,
      });
      return { ok: true, evidence, mia: { initialized: true, request } };
    } catch {
      return {
        ok: true,
        evidence,
        mia: { initialized: false, message: summaryNotStartedMessage },
      };
    }
  } catch (error) {
    return serviceFailure(error);
  }
}

export async function listEvidenceAction(input?: unknown): Promise<ListEvidenceResult> {
  const snapshot = await currentSession();
  const page = listPage(input);
  if ("ok" in page) {
    return page;
  }

  try {
    const evidence = await evidenceOperations().listEvidence(snapshot.userId, page.limit, page.cursor);
    return { ok: true, evidence };
  } catch (error) {
    return serviceFailure(error);
  }
}

export async function readEvidenceAction(input: unknown): Promise<ReadEvidenceResult> {
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
    return { ok: true, evidence };
  } catch (error) {
    return serviceFailure(error);
  }
}

export async function deleteEvidenceAction(input: unknown): Promise<DeleteEvidenceResult> {
  const snapshot = await currentSession();
  const evidenceId = evidenceIdFrom(input);
  const confirmation = confirmationFrom(input);
  if (!evidenceId || confirmation !== deleteEvidenceConfirmation) {
    return validation(
      confirmation === deleteEvidenceConfirmation ? invalidRequestMessage : "Confirmation is required before evidence can be deleted.",
    );
  }

  try {
    const deleted = await evidenceOperations().deleteEvidence(snapshot.userId, evidenceId);
    if (!deleted) {
      return notFound();
    }
    return { ok: true };
  } catch (error) {
    return serviceFailure(error);
  }
}

function listPage(input: unknown): { limit: number; cursor: EvidenceCursor | null } | EvidenceActionFailure {
  if (input == null) {
    return { limit: 20, cursor: null };
  }
  if (typeof input !== "object" || Array.isArray(input)) {
    return validation(invalidPageMessage);
  }

  const record = input as { limit?: unknown; cursor?: unknown };
  let limit = 20;
  if (record.limit !== undefined) {
    if (typeof record.limit !== "number" || !Number.isInteger(record.limit) || record.limit < 1 || record.limit > 50) {
      return validation(invalidPageMessage);
    }
    limit = record.limit;
  }

  if (record.cursor == null) {
    return { limit, cursor: null };
  }
  if (typeof record.cursor !== "object" || Array.isArray(record.cursor)) {
    return validation(invalidPageMessage);
  }

  const cursor = record.cursor as { beforeCreatedAt?: unknown; beforeId?: unknown };
  if (typeof cursor.beforeCreatedAt !== "string" || typeof cursor.beforeId !== "string") {
    return validation(invalidPageMessage);
  }
  if (!ISO_TIMESTAMP.test(cursor.beforeCreatedAt) || Number.isNaN(Date.parse(cursor.beforeCreatedAt)) || !UUID.test(cursor.beforeId)) {
    return validation(invalidPageMessage);
  }

  return {
    limit,
    cursor: { beforeCreatedAt: cursor.beforeCreatedAt, beforeId: cursor.beforeId.toLowerCase() },
  };
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

function confirmationFrom(input: unknown): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const confirmation = (input as { confirmation?: unknown }).confirmation;
  return typeof confirmation === "string" ? confirmation : null;
}

function validation(message: string, code?: EvidenceErrorCode): EvidenceActionFailure {
  return code ? { ok: false, kind: "validation", message, code } : { ok: false, kind: "validation", message };
}

function notFound(): EvidenceActionFailure {
  return { ok: false, kind: "not_found", message: notFoundMessage };
}

function serviceFailure(error: unknown): EvidenceActionFailure {
  if (error instanceof EvidenceServiceError) {
    if (error.kind === "unconfirmed") {
      return { ok: false, kind: "unconfirmed", message: error.message };
    }
    if (error.kind === "invalid") {
      return { ok: false, kind: "validation", message: error.message };
    }
    return { ok: false, kind: "unavailable", message: error.message };
  }
  return { ok: false, kind: "unavailable", message: evidenceUnavailableMessage };
}
