import "server-only";
import { randomUUID } from "node:crypto";
import { evidenceSql } from "@/server/evidence/pool";
import type { EvidenceSummary } from "@/server/evidence/types";
import { buildEvidencePacket, buildMiaPanelDocument, classifyQuestion, renderMiaAnswer, type FactReference, type MiaRefusalCode } from "./engine";
import { selectQuestionContext, type SelectionRefusalCode } from "./selection";
import {
  MIA_MAX_OUTPUT_TOKENS,
  MIA_MODEL,
  MIA_PROVIDER,
  MIA_TIMEOUT_MS,
  inputLimitMessage,
  miaModelRequest,
  miaProviderClient,
  providerFailureCategory,
  providerRefusalMessage,
  transportFailureCategory,
  usageFieldsValidated,
  type ProviderResult,
  type ProviderTransport,
} from "./provider";
import {
  canonicalizeMiaQuestion,
  miaFingerprint,
  miaQuestionOctets,
  MIA_QUESTION_MAX_OCTETS,
} from "./fingerprint";

const unavailableMessage = "The MIA request could not be completed.";
const reservationNotFoundMessage = "The MIA request was not found.";
const reservationRejectedMessage = "The reservation cannot be released.";
export const reservationReleaseReason = "owner_authorized_unknown_billing_release";
const mismatchMessage = "This submission does not match the original request.";
const notFoundMessage = "The evidence was not found.";
const emptyQuestionMessage = "Enter a question.";
const longQuestionMessage = "The question is too long.";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const requestStates = new Set([
  "submitted",
  "validating",
  "processing",
  "completed",
  "refused",
  "failed",
  "timed_out",
  "reconciliation_required",
]);

export class MiaServiceError extends Error {
  readonly kind: "unavailable" | "not_found" | "conflict" | "invalid";

  constructor(kind: "unavailable" | "not_found" | "conflict" | "invalid", message: string) {
    super(message);
    this.name = "MiaServiceError";
    this.kind = kind;
  }
}

export type MiaRequestRecord = {
  requestId: string;
  requestType: "performance_summary" | "evidence_question";
  state: string;
  resultCode: "created" | "progressed" | "unchanged" | "refused";
  availability: "awaiting_provider" | "refused";
  renderedText: string | null;
  failureCategory: string | null;
  createdAt: string | null;
  completedAt: string | null;
};

export type MiaQuestionRecord = MiaRequestRecord & {
  classification: { code: MiaRefusalCode; message: string; persisted: boolean } | null;
};

export type MiaContext = {
  evidenceId: string;
  parserVersion: string;
  calculationVersion: string;
  summary: EvidenceSummary;
  exchange: {
    question: string | null;
    answer: string | null;
    exchangedAt: string | null;
  };
};

export type MiaEvidenceIdentity = {
  id: string;
  parserVersion: string;
  calculationVersion: string;
  summary: EvidenceSummary;
};

type Sql = (query: TemplateStringsArray, ...values: readonly unknown[]) => Promise<unknown>;

const validatedRefusalCodes = new Set<MiaRefusalCode>([
  "recommendation",
  "external_benchmark",
  "prediction",
  "causal_claim",
]);

type OpenRow = {
  request_id: unknown;
  state: unknown;
  result_code: unknown;
};

type ReadRow = {
  request_id: unknown;
  request_type: unknown;
  state: unknown;
  rendered_text: unknown;
  failure_category: unknown;
  created_at: unknown;
  completed_at: unknown;
};

type RefusalRow = {
  request_id: unknown;
  state: unknown;
  result_code: unknown;
  rendered_text: unknown;
};

type ContextRow = {
  id: unknown;
  summary: unknown;
  latest_question: unknown;
  latest_answer: unknown;
  latest_exchange_at: unknown;
};

let openDatabase: () => Sql = () => evidenceSql() as unknown as Sql;

export function replaceMiaDatabase(next?: () => Sql): void {
  openDatabase = next ?? (() => evidenceSql() as unknown as Sql);
}

export function newMiaIdempotencyKey(): string {
  return randomUUID();
}

export async function ensurePerformanceSummary(
  ownerId: string,
  evidence: MiaEvidenceIdentity,
): Promise<MiaRequestRecord> {
  assertVersions(evidence);
  const fingerprint = miaFingerprint({
    parserVersion: evidence.summary.parserVersion,
    calculationVersion: evidence.summary.calculationVersion,
    requestType: "performance_summary",
    evidenceId: evidence.id,
    question: null,
  });
  return openRequest(ownerId, evidence.id, "performance_summary", newMiaIdempotencyKey(), fingerprint, null);
}

export async function openEvidenceQuestion(
  ownerId: string,
  evidence: MiaEvidenceIdentity,
  question: string,
  idempotencyKey: string,
): Promise<MiaQuestionRecord> {
  assertVersions(evidence);
  const canonical = canonicalizeMiaQuestion(question);
  if (!canonical) {
    throw new MiaServiceError("invalid", emptyQuestionMessage);
  }
  if (miaQuestionOctets(canonical) > MIA_QUESTION_MAX_OCTETS) {
    throw new MiaServiceError("invalid", longQuestionMessage);
  }
  const fingerprint = miaFingerprint({
    parserVersion: evidence.summary.parserVersion,
    calculationVersion: evidence.summary.calculationVersion,
    requestType: "evidence_question",
    evidenceId: evidence.id,
    question: canonical,
  });
  const request = await openRequest(
    ownerId,
    evidence.id,
    "evidence_question",
    idempotencyKey,
    fingerprint,
    canonical,
  );
  const classified = classifyQuestion(canonical);
  if (!classified || !validatedRefusalCodes.has(classified.code)) {
    return {
      ...request,
      classification: classified ? { code: classified.code, message: classified.message, persisted: false } : null,
    };
  }
  if (request.state !== "validating" && request.state !== "refused") {
    return {
      ...request,
      classification: { code: classified.code, message: classified.message, persisted: false },
    };
  }

  const persisted = await persistValidatedRefusal(ownerId, evidence.id, request.requestId, classified.code);
  const stored = await readOwnedRequest(ownerId, evidence.id, request.requestId);
  const renderedText = stored?.renderedText ?? persisted.renderedText;
  const state = stored?.state ?? persisted.state;
  if (state !== "refused" || !renderedText) {
    throw new MiaServiceError("unavailable", unavailableMessage);
  }
  return {
    ...request,
    state,
    resultCode: persisted.resultCode,
    availability: "refused",
    renderedText,
    failureCategory: stored?.failureCategory ?? null,
    createdAt: stored?.createdAt ?? request.createdAt,
    completedAt: stored?.completedAt ?? request.completedAt,
    classification: { code: classified.code, message: renderedText, persisted: true },
  };
}

export async function readMiaContext(ownerId: string, evidenceId: string): Promise<MiaContext | null> {
  let rows: ContextRow[];
  try {
    rows = (await database()`
      select id, summary, latest_question, latest_answer, latest_exchange_at
      from private.read_mia_evidence_context(${ownerId}::uuid, ${evidenceId}::uuid)
    `) as ContextRow[];
  } catch (error) {
    throw publish(error);
  }
  return mapContext(rows[0]);
}

async function openRequest(
  ownerId: string,
  evidenceId: string,
  requestType: "performance_summary" | "evidence_question",
  idempotencyKey: string,
  fingerprint: string,
  question: string | null,
): Promise<MiaRequestRecord> {
  let rows: OpenRow[];
  try {
    rows = (await database()`
      select request_id, state, result_code
      from private.open_mia_request(
        ${ownerId}::uuid,
        ${evidenceId}::uuid,
        ${requestType},
        ${idempotencyKey},
        ${fingerprint},
        ${question}
      )
    `) as OpenRow[];
  } catch (error) {
    throw publish(error);
  }

  const row = rows[0];
  const resultCode = text(row?.result_code);
  if (resultCode === "not_found") {
    throw new MiaServiceError("not_found", notFoundMessage);
  }
  if (resultCode === "fingerprint_mismatch") {
    throw new MiaServiceError("conflict", mismatchMessage);
  }
  const requestId = text(row?.request_id);
  const state = text(row?.state);
  if (!requestId || !state || !requestStates.has(state) || (resultCode !== "created" && resultCode !== "progressed" && resultCode !== "unchanged")) {
    throw new MiaServiceError("unavailable", unavailableMessage);
  }
  const stored = await readOwnedRequest(ownerId, evidenceId, requestId);
  if (!stored || stored.requestType !== requestType) {
    throw new MiaServiceError("unavailable", unavailableMessage);
  }
  return {
    requestId,
    requestType,
    state: stored.state,
    resultCode,
    availability: stored.state === "refused" ? "refused" : "awaiting_provider",
    renderedText: stored.renderedText,
    failureCategory: stored.failureCategory,
    createdAt: stored.createdAt,
    completedAt: stored.completedAt,
  };
}

export async function dispatchValidatedRequest<T extends MiaRequestRecord>(
  ownerId: string,
  evidence: MiaEvidenceIdentity,
  request: T,
  question: string | null,
): Promise<T> {
  if (request.state !== "validating" || request.availability === "refused") {
    return request;
  }
  let packet;
  let allowedReferences: FactReference[] | undefined;
  let modelQuestion = question;
  if (request.requestType === "evidence_question") {
    const selected = selectQuestionContext(evidence.id, evidence.summary, question ?? "");
    if (selected.status === "refused") {
      const persisted = await persistSelectionRefusal(ownerId, evidence.id, request.requestId, selected.code);
      const stored = await readOwnedRequest(ownerId, evidence.id, request.requestId);
      const renderedText = stored?.renderedText ?? persisted.renderedText;
      const state = stored?.state ?? persisted.state;
      if (state !== "refused" || !renderedText) {
        throw new MiaServiceError("unavailable", unavailableMessage);
      }
      return {
        ...request,
        state,
        resultCode: persisted.resultCode,
        availability: "refused",
        renderedText,
        failureCategory: null,
        completedAt: stored?.completedAt ?? request.completedAt,
      };
    }
    packet = selected.packet;
    allowedReferences = selected.references;
    modelQuestion = selected.question;
  } else {
    packet = buildEvidencePacket(evidence.id, evidence.summary);
  }
  const client = miaProviderClient();
  if (!client) {
    return request;
  }
  const body = miaModelRequest(packet, modelQuestion);
  if (!body) {
    const failed = await failBeforeDispatch(ownerId, evidence.id, request.requestId);
    if (failed === "failed" || failed === "unchanged") {
      return storedRequest(ownerId, evidence.id, {
        ...request,
        state: "failed",
        renderedText: null,
        failureCategory: inputLimitMessage,
      });
    }
    return request;
  }
  const claimed = await claimDispatch(ownerId, request.requestId);
  if (!claimed.authorized || !claimed.provider || !claimed.model) {
    return request;
  }
  if (claimed.provider !== MIA_PROVIDER || claimed.model !== MIA_MODEL) {
    await recordDispatch(ownerId, evidence.id, request, {
      outcome: "failed",
      billing: "non_billable",
      usage: emptyUsage(),
      latencyMs: 0,
      renderedText: null,
      references: null,
      failureCategory: "unapproved_model",
      question: null,
    });
    return storedRequest(ownerId, evidence.id, request);
  }
  try {
    const result = await client.respond({
      model: claimed.model,
      body,
      maxOutputTokens: MIA_MAX_OUTPUT_TOKENS,
      timeoutMs: MIA_TIMEOUT_MS,
    });
    if (result.transport && result.transport.outcome !== "accepted") {
      await recordDispatch(ownerId, evidence.id, request, {
        outcome: result.transport.outcome === "timeout" ? "timed_out" : "failed",
        billing: "unknown",
        usage: emptyUsage(),
        latencyMs: result.latencyMs,
        renderedText: null,
        references: null,
        failureCategory: transportFailureCategory[result.transport.outcome],
        question: null,
        transport: result.transport,
      });
      return storedRequest(ownerId, evidence.id, request);
    }
    return await acceptProviderResult(ownerId, evidence, request, modelQuestion, result, allowedReferences);
  } catch (error) {
    const timedOut = error instanceof Error && error.name === "AbortError";
    await recordDispatch(ownerId, evidence.id, request, {
      outcome: timedOut ? "timed_out" : "failed",
      billing: "unknown",
      usage: emptyUsage(),
      latencyMs: null,
      renderedText: null,
      references: null,
      failureCategory: timedOut ? "timeout" : "provider_error",
      question: null,
    });
    return storedRequest(ownerId, evidence.id, request);
  }
}

async function acceptProviderResult<T extends MiaRequestRecord>(
  ownerId: string,
  evidence: MiaEvidenceIdentity,
  request: T,
  question: string | null,
  result: ProviderResult,
  allowedReferences?: readonly FactReference[],
): Promise<T> {
  const usage = result.usage;
  const priced = usage.inputTokens !== null
    && usage.cachedInputTokens !== null
    && usage.outputTokens !== null
    && usage.otherBillableTokens === null;
  if (result.disposition !== "completed") {
    await recordDispatch(ownerId, evidence.id, request, {
      outcome: result.disposition === "refused" ? "refused" : "failed",
      billing: priced ? "reported" : "unknown",
      usage,
      latencyMs: result.latencyMs,
      renderedText: result.disposition === "refused" ? providerRefusalMessage : null,
      references: null,
      failureCategory: providerFailureCategory[result.disposition === "refused"
        ? "refusal"
        : result.disposition === "incomplete"
          ? "incomplete"
          : result.disposition === "failed"
            ? "failed"
            : "unverified"],
      question: null,
      transport: result.transport,
    });
    return storedRequest(ownerId, evidence.id, request);
  }
  if (!priced) {
    await recordDispatch(ownerId, evidence.id, request, {
      outcome: "reconciliation_required",
      billing: "unknown",
      usage,
      latencyMs: result.latencyMs,
      renderedText: null,
      references: null,
      failureCategory: "unreconciled_billing",
      question: null,
      transport: result.transport,
    });
    return storedRequest(ownerId, evidence.id, request);
  }
  const answer = renderMiaAnswer({
    evidenceId: evidence.id,
    summary: evidence.summary,
    question: question ?? undefined,
    response: result.output,
    allowedReferences,
  });
  if (request.requestType === "performance_summary") {
    const document = buildMiaPanelDocument({
      evidenceId: evidence.id,
      summary: evidence.summary,
      response: result.output,
    });
    await recordDispatch(ownerId, evidence.id, request, {
      outcome: document ? "completed" : "refused",
      billing: "reported",
      usage,
      latencyMs: result.latencyMs,
      renderedText: document ? JSON.stringify(document) : answer.refusals[0]?.message ?? null,
      references: referenceList(result.output),
      failureCategory: null,
      question: null,
      transport: result.transport,
    });
    return storedRequest(ownerId, evidence.id, request);
  }
  const rendered = answer.status === "answered"
    ? answer.sentences.join(" ")
    : answer.refusals[0]?.message ?? null;
  await recordDispatch(ownerId, evidence.id, request, {
    outcome: answer.status === "answered" ? "completed" : "refused",
    billing: "reported",
    usage,
    latencyMs: result.latencyMs,
    renderedText: rendered,
    references: referenceList(result.output),
    failureCategory: null,
    question: rendered ? question : null,
    transport: result.transport,
  });
  return storedRequest(ownerId, evidence.id, request);
}

async function failBeforeDispatch(
  ownerId: string,
  evidenceId: string,
  requestId: string,
): Promise<string | null> {
  const rows = (await database()`
    select result_code
    from private.fail_mia_request_before_dispatch(
      ${ownerId}::uuid,
      ${evidenceId}::uuid,
      ${requestId}::uuid
    )
  `) as { result_code?: unknown }[];
  return text(rows[0]?.result_code);
}

async function claimDispatch(ownerId: string, requestId: string): Promise<{
  authorized: boolean;
  provider: string | null;
  model: string | null;
}> {
  const rows = (await database()`
    select authorized, provider, model
    from private.claim_mia_dispatch(${ownerId}::uuid, ${requestId}::uuid)
  `) as { authorized?: unknown; provider?: unknown; model?: unknown }[];
  return {
    authorized: rows[0]?.authorized === true,
    provider: text(rows[0]?.provider),
    model: text(rows[0]?.model),
  };
}

async function recordDispatch(
  ownerId: string,
  evidenceId: string,
  request: MiaRequestRecord,
  input: {
    outcome: "completed" | "refused" | "failed" | "timed_out" | "reconciliation_required";
    billing: "reported" | "non_billable" | "unknown";
    usage: ProviderResult["usage"];
    latencyMs: number | null;
    renderedText: string | null;
    references: unknown[] | null;
    failureCategory: string | null;
    question: string | null;
    transport?: ProviderTransport;
  },
): Promise<void> {
  const canonicalQuestion = input.question ? canonicalizeMiaQuestion(input.question) : null;
  const exchangeQuestion = canonicalQuestion && input.renderedText ? canonicalQuestion : null;
  const exchangeAnswer = exchangeQuestion ? input.renderedText : null;
  const transport = input.transport;
  await database()`
    select usage_updated
    from private.record_mia_attempt_outcome(
      ${ownerId}::uuid,
      ${request.requestId}::uuid,
      ${1}::integer,
      ${input.outcome},
      ${input.billing},
      ${input.usage.inputTokens}::integer,
      ${input.usage.outputTokens}::integer,
      ${input.usage.otherBillableTokens}::integer,
      ${null}::numeric,
      ${input.billing === "reported" ? 0 : null}::numeric,
      ${input.latencyMs}::integer,
      ${input.renderedText},
      ${input.references === null ? null : JSON.stringify(input.references)}::jsonb,
      ${input.failureCategory},
      ${exchangeQuestion},
      ${exchangeAnswer},
      ${input.usage.cachedInputTokens}::integer,
      ${transport?.outcome ?? null},
      ${transport?.httpResponseReceived ?? null}::boolean,
      ${transport?.httpStatus ?? null}::integer,
      ${transport?.providerRequestId ?? null},
      ${usageFieldsValidated(input.usage)}::boolean
    )
  `;
}

async function storedRequest<T extends MiaRequestRecord>(
  ownerId: string,
  evidenceId: string,
  request: T,
): Promise<T> {
  const stored = await readOwnedRequest(ownerId, evidenceId, request.requestId);
  if (!stored) {
    return request;
  }
  return {
    ...request,
    state: stored.state,
    availability: stored.state === "refused" ? "refused" : request.availability,
    renderedText: stored.renderedText,
    failureCategory: stored.failureCategory,
    completedAt: stored.completedAt,
  };
}

function emptyUsage(): ProviderResult["usage"] {
  return {
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    otherBillableTokens: null,
  };
}

function referenceList(output: unknown): unknown[] {
  if (!output || typeof output !== "object" || Array.isArray(output)) {
    return [];
  }
  const facts = (output as { facts?: unknown }).facts;
  if (!Array.isArray(facts)) {
    return [];
  }
  return facts.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return [];
    }
    const record = item as Record<string, unknown>;
    return [{
      metricId: record.metricId,
      dimension: record.dimension,
      dimensionValue: record.dimensionValue,
      period: record.period,
      unit: record.unit,
      evidenceId: record.evidenceId,
    }];
  });
}

async function persistSelectionRefusal(
  ownerId: string,
  evidenceId: string,
  requestId: string,
  code: SelectionRefusalCode,
): Promise<{ state: string; resultCode: "refused" | "unchanged"; renderedText: string }> {
  const first = await selectionRefusalAttempt(ownerId, evidenceId, requestId, code);
  if (first !== "ambiguous") {
    return first;
  }
  const second = await selectionRefusalAttempt(ownerId, evidenceId, requestId, code);
  if (second !== "ambiguous") {
    return second;
  }
  const stored = await readOwnedRequest(ownerId, evidenceId, requestId).catch(() => null);
  if (stored?.state === "refused" && stored.renderedText) {
    return { state: stored.state, resultCode: "unchanged", renderedText: stored.renderedText };
  }
  throw new MiaServiceError("unavailable", unavailableMessage);
}

async function selectionRefusalAttempt(
  ownerId: string,
  evidenceId: string,
  requestId: string,
  code: SelectionRefusalCode,
): Promise<{ state: string; resultCode: "refused" | "unchanged"; renderedText: string } | "ambiguous"> {
  let rows: RefusalRow[];
  try {
    rows = (await database()`
      select request_id, state, result_code, rendered_text
      from private.refuse_mia_selection(
        ${ownerId}::uuid,
        ${evidenceId}::uuid,
        ${requestId}::uuid,
        ${code}
      )
    `) as RefusalRow[];
  } catch (error) {
    if (error instanceof MiaServiceError && error.kind !== "unavailable") {
      throw error;
    }
    return "ambiguous";
  }

  const resultCode = text(rows[0]?.result_code);
  if (resultCode === "not_found") {
    throw new MiaServiceError("not_found", notFoundMessage);
  }
  const renderedText = text(rows[0]?.rendered_text);
  const state = text(rows[0]?.state);
  if ((resultCode === "refused" || resultCode === "unchanged") && state === "refused" && renderedText) {
    return { state, resultCode, renderedText };
  }
  throw new MiaServiceError("unavailable", unavailableMessage);
}

async function persistValidatedRefusal(
  ownerId: string,
  evidenceId: string,
  requestId: string,
  code: MiaRefusalCode,
): Promise<{ state: string; resultCode: "refused" | "unchanged"; renderedText: string }> {
  const first = await refusalAttempt(ownerId, evidenceId, requestId, code);
  if (first !== "ambiguous") {
    return first;
  }
  const second = await refusalAttempt(ownerId, evidenceId, requestId, code);
  if (second !== "ambiguous") {
    return second;
  }
  const stored = await readOwnedRequest(ownerId, evidenceId, requestId).catch(() => null);
  if (stored?.state === "refused" && stored.renderedText) {
    return { state: stored.state, resultCode: "unchanged", renderedText: stored.renderedText };
  }
  throw new MiaServiceError("unavailable", unavailableMessage);
}

async function refusalAttempt(
  ownerId: string,
  evidenceId: string,
  requestId: string,
  code: MiaRefusalCode,
): Promise<{ state: string; resultCode: "refused" | "unchanged"; renderedText: string } | "ambiguous"> {
  let rows: RefusalRow[];
  try {
    rows = (await database()`
      select request_id, state, result_code, rendered_text
      from private.refuse_validated_mia_question(
        ${ownerId}::uuid,
        ${evidenceId}::uuid,
        ${requestId}::uuid,
        ${code}
      )
    `) as RefusalRow[];
  } catch (error) {
    if (error instanceof MiaServiceError && error.kind !== "unavailable") {
      throw error;
    }
    return "ambiguous";
  }

  const resultCode = text(rows[0]?.result_code);
  if (resultCode === "not_found") {
    throw new MiaServiceError("not_found", notFoundMessage);
  }
  const renderedText = text(rows[0]?.rendered_text);
  const state = text(rows[0]?.state);
  if ((resultCode === "refused" || resultCode === "unchanged") && state === "refused" && renderedText) {
    return { state, resultCode, renderedText };
  }
  throw new MiaServiceError("unavailable", unavailableMessage);
}

async function readOwnedRequest(
  ownerId: string,
  evidenceId: string,
  requestId: string,
): Promise<{
  requestType: MiaRequestRecord["requestType"];
  state: string;
  renderedText: string | null;
  failureCategory: string | null;
  createdAt: string | null;
  completedAt: string | null;
} | null> {
  let rows: ReadRow[];
  try {
    rows = (await database()`
      select request_id, request_type, state, rendered_text, failure_category, created_at, completed_at
      from private.read_mia_request(${ownerId}::uuid, ${evidenceId}::uuid, ${requestId}::uuid)
    `) as ReadRow[];
  } catch (error) {
    throw publish(error);
  }
  const row = rows[0];
  const id = text(row?.request_id);
  const requestType = text(row?.request_type);
  const state = text(row?.state);
  if (!row || id !== requestId || (requestType !== "performance_summary" && requestType !== "evidence_question") || !state || !requestStates.has(state)) {
    return null;
  }
  return {
    requestType,
    state,
    renderedText: nullableText(row.rendered_text),
    failureCategory: nullableText(row.failure_category),
    createdAt: timestamp(row.created_at),
    completedAt: timestamp(row.completed_at),
  };
}

function assertVersions(evidence: MiaEvidenceIdentity): void {
  if (
    evidence.summary.parserVersion !== evidence.parserVersion
    || evidence.summary.calculationVersion !== evidence.calculationVersion
  ) {
    throw new MiaServiceError("unavailable", unavailableMessage);
  }
}

function mapContext(row: ContextRow | undefined): MiaContext | null {
  const evidenceId = text(row?.id);
  if (!row || !evidenceId || !row.summary || typeof row.summary !== "object" || Array.isArray(row.summary)) {
    return null;
  }
  const summary = { ...(row.summary as EvidenceSummary & { sourceText?: unknown }) };
  delete summary.sourceText;
  const parserVersion = text(summary.parserVersion);
  const calculationVersion = text(summary.calculationVersion);
  if (!parserVersion || !calculationVersion) {
    return null;
  }
  return {
    evidenceId,
    parserVersion,
    calculationVersion,
    summary,
    exchange: {
      question: nullableText(row.latest_question),
      answer: nullableText(row.latest_answer),
      exchangedAt: timestamp(row.latest_exchange_at),
    },
  };
}

export type ReservationReconciliation = {
  alreadyRecorded: boolean;
  phpReserved: string;
  usdReserved: string;
  phpSpent: string;
  usdSpent: string;
};

export type EligibleReservation = {
  requestId: string;
  billingStatus: "unknown";
  phpAmount: string;
  usdAmount: string;
};

export async function listEligibleUnknownReservations(ownerId: string): Promise<EligibleReservation[]> {
  if (!UUID.test(ownerId)) {
    throw new MiaServiceError("unavailable", unavailableMessage);
  }
  let rows: {
    request_id?: unknown;
    attempt_number?: unknown;
    billing_status?: unknown;
    php_amount?: unknown;
    usd_amount?: unknown;
  }[];
  try {
    rows = (await database()`
      select request_id, attempt_number, billing_status, php_amount, usd_amount
      from private.list_eligible_mia_reservations(${ownerId}::uuid)
    `) as typeof rows;
  } catch (error) {
    throw publish(error);
  }
  return rows.map((row) => {
    const requestId = text(row.request_id);
    const phpAmount = decimalText(row.php_amount);
    const usdAmount = decimalText(row.usd_amount);
    if (
      !requestId
      || !UUID.test(requestId)
      || row.attempt_number !== 1
      || row.billing_status !== "unknown"
      || !phpAmount
      || !usdAmount
    ) {
      throw new MiaServiceError("unavailable", unavailableMessage);
    }
    return {
      requestId: requestId.toLowerCase(),
      billingStatus: "unknown" as const,
      phpAmount: canonicalDecimalText(phpAmount),
      usdAmount: canonicalDecimalText(usdAmount),
    };
  });
}

export async function reconcileUnknownReservation(
  ownerId: string,
  requestId: string,
  phpAmount: string,
  usdAmount: string,
): Promise<ReservationReconciliation> {
  let rows: {
    reconciled?: unknown;
    already_recorded?: unknown;
    php_reserved?: unknown;
    usd_reserved?: unknown;
    php_spent?: unknown;
    usd_spent?: unknown;
  }[];
  try {
    rows = (await database()`
      select reconciled, already_recorded, php_reserved, usd_reserved, php_spent, usd_spent
      from private.reconcile_unknown_reservation(
        ${ownerId}::uuid,
        ${requestId}::uuid,
        ${phpAmount}::numeric,
        ${usdAmount}::numeric,
        ${reservationReleaseReason}
      )
    `) as typeof rows;
  } catch (error) {
    throw reconcileFailure(error);
  }
  const row = rows[0];
  const phpReserved = decimalText(row?.php_reserved);
  const usdReserved = decimalText(row?.usd_reserved);
  const phpSpent = decimalText(row?.php_spent);
  const usdSpent = decimalText(row?.usd_spent);
  if (row?.reconciled !== true || !phpReserved || !usdReserved || !phpSpent || !usdSpent) {
    throw new MiaServiceError("unavailable", unavailableMessage);
  }
  return {
    alreadyRecorded: row.already_recorded === true,
    phpReserved,
    usdReserved,
    phpSpent,
    usdSpent,
  };
}

function reconcileFailure(error: unknown): Error {
  if (error instanceof MiaServiceError) {
    return error;
  }
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : "";
  if (code === "P0002") {
    return new MiaServiceError("not_found", reservationNotFoundMessage);
  }
  if (code === "22023") {
    return new MiaServiceError("invalid", reservationRejectedMessage);
  }
  return new MiaServiceError("unavailable", unavailableMessage);
}

function decimalText(value: unknown): string | null {
  return typeof value === "string" && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value) ? value : null;
}

export function canonicalDecimalText(value: string): string {
  const point = value.indexOf(".");
  if (point === -1) {
    return value;
  }
  const fraction = value.slice(point + 1).replace(/0+$/, "");
  return fraction.length === 0 ? value.slice(0, point) : `${value.slice(0, point)}.${fraction}`;
}

function database(): Sql {
  try {
    return openDatabase();
  } catch (error) {
    throw publish(error);
  }
}

function publish(error: unknown): Error {
  if (error instanceof MiaServiceError) {
    return error;
  }
  return new MiaServiceError("unavailable", unavailableMessage);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function timestamp(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  return typeof value === "string" && value.length > 0 ? value : null;
}
