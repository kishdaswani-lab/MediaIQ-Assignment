import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { afterEach, describe, it } from "node:test";
import { accessDecision, type AuthContext } from "../auth/policy";
import { uploadEvidenceAction } from "../evidence/actions";
import { replaceEvidenceActionDependencies } from "../evidence/action-dependencies";
import { CALCULATION_VERSION, PARSER_VERSION, type EvidenceSummary } from "../evidence/types";
import { askMiaQuestionAction, generateMiaSummaryAction, initializeMiaSummaryAction, listEligibleReservationsAction, readMiaContextAction, reconcileMiaReservationAction } from "./actions";
import { replaceMiaOperations } from "./dependencies";
import { classifyQuestion } from "./engine";
import { canonicalizeMiaQuestion, miaFingerprint, MIA_CONTEXT_VERSION } from "./fingerprint";
import {
  ensurePerformanceSummary,
  MiaServiceError,
  openEvidenceQuestion,
  readMiaContext,
  canonicalDecimalText,
  listEligibleUnknownReservations,
  reconcileUnknownReservation,
  replaceMiaDatabase,
  type MiaEvidenceIdentity,
  type MiaQuestionRecord,
  type MiaRequestRecord,
} from "./service";

const userA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const userB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
const forgedOwner = "cccccccc-cccc-4ccc-8ccc-ccccccccccc3";
const evidenceId = "11111111-1111-4111-8111-111111111111";
const requestId = "99999999-9999-4999-8999-999999999999";
const csv = "date,campaign,channel,spend,impressions,clicks\nSECRET-CSV-ROW\n";

const summary: EvidenceSummary = {
  calculationVersion: CALCULATION_VERSION,
  parserVersion: PARSER_VERSION,
  currencySource: "upload",
  period: { start: "2024-02-01", end: "2024-02-01" },
  impressions: "9",
  clicks: "3",
  ctr: { kind: "omitted", reason: "not_exact" },
  currencies: [],
  channels: [],
  campaigns: [],
};

const evidence: MiaEvidenceIdentity = {
  id: evidenceId,
  parserVersion: PARSER_VERSION,
  calculationVersion: CALCULATION_VERSION,
  summary,
};

type Call = { text: string; values: unknown[] };
const calls: Call[] = [];
let rows: unknown[] = [];
let refuseFailures = 0;

type Snapshot = {
  userId: string;
  email: string;
  emailConfirmed: boolean;
  assurance: "aal1" | "aal2";
  verifiedTotp: boolean;
};

const actionCalls: { method: string; args: unknown[] }[] = [];
let session: Snapshot | null = protectedUser(userA);
let summaryError: Error | null = null;
let summaryState = "validating";
let storedExchange = { question: "Earlier question?", answer: "Earlier answer.", exchangedAt: "2024-03-01T00:00:00.000Z" };

installDatabase();
installActions();

afterEach(() => {
  calls.length = 0;
  actionCalls.length = 0;
  rows = [];
  refuseFailures = 0;
  session = protectedUser(userA);
  summaryError = null;
  summaryState = "validating";
  storedExchange = { question: "Earlier question?", answer: "Earlier answer.", exchangedAt: "2024-03-01T00:00:00.000Z" };
  installDatabase();
  installActions();
});

describe("MIA fingerprint", () => {
  it("canonicalizes NFC and whitespace without changing case or punctuation", () => {
    assert.equal(canonicalizeMiaQuestion("  What   is   spend? \r\n"), "What is spend?");
    assert.equal(canonicalizeMiaQuestion("e\u0301"), "\u00e9");
    assert.equal(canonicalizeMiaQuestion("Keep \uFB01 Case!"), "Keep \uFB01 Case!");
    assert.equal(canonicalizeMiaQuestion(" \n\t "), null);
  });

  it("hashes the approved field order and keeps the question out of a summary", () => {
    const fingerprint = miaFingerprint({
      parserVersion: PARSER_VERSION,
      calculationVersion: CALCULATION_VERSION,
      requestType: "performance_summary",
      evidenceId: evidenceId.toUpperCase(),
      question: null,
    });
    const canonical = [
      `{"contextVersion":"${MIA_CONTEXT_VERSION}"`,
      `,"parserVersion":"${PARSER_VERSION}"`,
      `,"calculationVersion":"${CALCULATION_VERSION}"`,
      `,"requestType":"performance_summary"`,
      `,"evidenceId":"${evidenceId}"`,
      `,"parameters":{}`,
      `,"question":null}`,
    ].join("");
    assert.equal(fingerprint, createHash("sha256").update(canonical, "utf8").digest("hex"));
    assert.equal(canonical.includes(csv), false);
    assert.notEqual(
      miaFingerprint({ ...evidenceFingerprint("What is spend?"), question: "What is spend?" }),
      miaFingerprint({ ...evidenceFingerprint("what is spend?"), question: "what is spend?" }),
    );
  });
});

describe("MIA request service", () => {
  it("creates one summary request and returns the same request for the same evidence", async () => {
    rows = [
      openRow("created"),
      readRow("validating", null, "performance_summary"),
      openRow("unchanged"),
      readRow("validating", null, "performance_summary"),
    ];
    const created = await ensurePerformanceSummary(userA, evidence);
    const again = await ensurePerformanceSummary(userA, evidence);

    assert.equal(created.resultCode, "created");
    assert.equal(again.resultCode, "unchanged");
    assert.equal(again.requestId, requestId);
    assert.equal(created.availability, "awaiting_provider");
    assert.equal(created.renderedText, null);
    assert.equal(created.createdAt, "2024-03-02T00:00:00.000Z");
    assert.notEqual(calls[0].values[3], calls[2].values[3]);
    assert.equal(calls[0].values[2], "performance_summary");
    assert.equal(calls[0].values[5], null);
    assert.equal(calls[0].values[4], calls[2].values[4]);
    assert.equal(calls[1].text.includes("read_mia_request"), true);
    assert.equal(calls[1].values[0], userA);
    assert.equal(calls[1].values[1], evidenceId);
    assert.equal(joinedSql().includes("refuse_validated_mia_question"), false);
    assert.equal(joinedSql().includes("claim_mia_dispatch"), false);
    assert.equal(joinedSql().includes("record_mia_attempt_outcome"), false);
    assert.equal(joinedSql().includes("mia_approved_provider"), false);
    assert.equal(joinedSql().includes("SECRET-CSV-ROW"), false);
  });

  it("reuses one question key and rejects the same key with another fingerprint", async () => {
    rows = [
      openRow("created"),
      readRow("validating", null),
      openRow("unchanged"),
      readRow("validating", null),
    ];
    const first = await openEvidenceQuestion(userA, evidence, "  What\r\nis spend? ", "question-key");
    const retry = await openEvidenceQuestion(userA, evidence, "What is spend?", "question-key");
    assert.equal(first.requestId, retry.requestId);
    assert.equal(calls[0].values[3], "question-key");
    assert.equal(calls[0].values[5], "What is spend?");
    assert.equal(calls[0].values[4], calls[2].values[4]);

    rows = [{ request_id: requestId, state: "validating", result_code: "fingerprint_mismatch" }];
    await assert.rejects(
      () => openEvidenceQuestion(userA, evidence, "What is revenue?", "question-key"),
      (error: unknown) => error instanceof MiaServiceError && error.kind === "conflict",
    );
  });

  it("gives different intentional questions different keys and keeps the stored exchange separate", async () => {
    const firstKey = "11111111-1111-4111-8111-111111111111";
    const secondKey = "22222222-2222-4222-8222-222222222222";
    rows = [
      openRow("created"),
      readRow("validating", null),
      openRow("created"),
      readRow("validating", null),
    ];
    await openEvidenceQuestion(userA, evidence, "What is spend?", firstKey);
    await openEvidenceQuestion(userA, evidence, "What is revenue?", secondKey);
    assert.notEqual(calls[0].values[3], calls[2].values[3]);
    assert.notEqual(calls[0].values[4], calls[2].values[4]);
    assert.equal(calls[0].values[2], "evidence_question");
    assert.equal(calls[1].text.includes("read_mia_request"), true);
    assert.equal(calls[0].text.includes("read_mia_evidence_context"), false);

    rows = [{
      id: evidenceId,
      summary: { ...summary, sourceText: csv },
      latest_question: "Earlier question?",
      latest_answer: "Earlier answer.",
      latest_exchange_at: new Date("2024-03-01T00:00:00.000Z"),
    }];
    const context = await readMiaContext(userA, evidenceId);
    assert.ok(context);
    assert.equal(context?.parserVersion, PARSER_VERSION);
    assert.equal(context?.calculationVersion, CALCULATION_VERSION);
    assert.equal(context?.exchange.question, "Earlier question?");
    assert.equal(context?.exchange.answer, "Earlier answer.");
    assert.equal(JSON.stringify(context).includes("SECRET-CSV-ROW"), false);
    assert.equal(JSON.stringify(context).includes("sourceText"), false);
    assert.equal(joinedSql().includes("source_text"), false);
  });

  it("matches the four database refusal sentences character for character", () => {
    assert.equal(
      classifyQuestion("Should we increase the budget?")?.message,
      "MIA cannot recommend a campaign or budget change from this evidence.",
    );
    assert.equal(
      classifyQuestion("What is the industry average?")?.message,
      "MIA cannot use an external benchmark. Only this saved evidence is available.",
    );
    assert.equal(
      classifyQuestion("Will this campaign perform next quarter?")?.message,
      "MIA cannot predict future performance from this evidence.",
    );
    assert.equal(
      classifyQuestion("Why did spend change?")?.message,
      "MIA cannot explain a cause from this evidence.",
    );
  });

  it("displays the database refusal sentence and does not send that sentence back", async () => {
    const databaseSentence = "Stored refusal from the database.";
    rows = [
      openRow("created"),
      readRow("validating", null),
      refusalRow("refused", databaseSentence),
      readRow("refused", databaseSentence),
    ];
    const refused = await openEvidenceQuestion(userA, evidence, "Should we increase the budget?", "refusal-key");
    const refusalCall = calls.find((call) => call.text.includes("refuse_validated_mia_question"));
    assert.equal(refused.classification?.code, "recommendation");
    assert.equal(refused.classification?.persisted, true);
    assert.equal(refused.classification?.message, databaseSentence);
    assert.notEqual(refused.classification?.message, classifyQuestion("Should we increase the budget?")?.message);
    assert.equal(refused.renderedText, databaseSentence);
    assert.equal(refused.state, "refused");
    assert.equal(refused.availability, "refused");
    assert.equal(refusalCall?.values[3], "recommendation");
    assert.equal(refusalCall?.values.includes(databaseSentence), false);
    assert.equal(calls.filter((call) => call.text.includes("open_mia_request")).length, 1);
    assert.equal(joinedSql().includes("claim_mia_dispatch"), false);
    assert.equal(joinedSql().includes("record_mia_attempt_outcome"), false);
    assert.equal(joinedSql().includes("mia_usage"), false);
  });

  it("retries an ambiguous refusal on the same request and does not open another question", async () => {
    const databaseSentence = "MIA cannot explain a cause from this evidence.";
    refuseFailures = 1;
    rows = [
      openRow("created"),
      readRow("validating", null),
      refusalRow("unchanged", databaseSentence),
      readRow("refused", databaseSentence),
    ];
    const refused = await openEvidenceQuestion(userA, evidence, "Why did spend change?", "causal-key");
    assert.equal(refused.classification?.message, databaseSentence);
    assert.equal(refused.resultCode, "unchanged");
    assert.equal(calls.filter((call) => call.text.includes("open_mia_request")).length, 1);
    assert.equal(calls.filter((call) => call.text.includes("refuse_validated_mia_question")).length, 2);

    calls.length = 0;
    refuseFailures = 2;
    rows = [
      openRow("created"),
      readRow("validating", null),
      readRow("refused", databaseSentence),
    ];
    const recovered = await openEvidenceQuestion(userA, evidence, "Why did spend change?", "causal-key");
    assert.equal(recovered.renderedText, databaseSentence);
    assert.equal(recovered.classification?.persisted, true);
    assert.equal(calls.filter((call) => call.text.includes("open_mia_request")).length, 1);
    assert.equal(calls.filter((call) => call.text.includes("refuse_validated_mia_question")).length, 2);
    assert.equal(joinedSql().includes("claim_mia_dispatch"), false);
  });

  it("does not open a request for another owner's evidence", async () => {
    rows = [{ request_id: null, state: null, result_code: "not_found" }];
    await assert.rejects(
      () => ensurePerformanceSummary(userB, evidence),
      (error: unknown) => error instanceof MiaServiceError && error.kind === "not_found",
    );
  });

  it("sends decimal strings to reconciliation and does not rewrite usage", async () => {
    rows = [{
      reconciled: true,
      already_recorded: false,
      php_reserved: "0",
      usd_reserved: "0",
      php_spent: "0",
      usd_spent: "0",
    }];
    const result = await reconcileUnknownReservation(userA, requestId, "0.03872", "0.00055");
    assert.equal(result.alreadyRecorded, false);
    assert.equal(result.phpSpent, "0");
    assert.equal(result.usdSpent, "0");
    assert.equal(calls[0].values[0], userA);
    assert.equal(calls[0].values[2], "0.03872");
    assert.equal(calls[0].values[3], "0.00055");
    assert.equal(calls[0].values[4], "owner_authorized_unknown_billing_release");
    assert.equal(calls[0].text.includes("reconcile_unknown_reservation"), true);
    assert.equal(calls[0].text.includes("mia_usage"), false);
    assert.equal(calls[0].text.includes("billing_status"), false);
  });

  it("keeps exact lookup decimals and fails closed on a malformed row", async () => {
    rows = [{
      request_id: requestId,
      attempt_number: 1,
      billing_status: "unknown",
      php_amount: "0.03872000000000000000",
      usd_amount: "0.00055000000000000000",
    }];
    const listed = await listEligibleUnknownReservations(userA);
    assert.deepEqual(listed, [{
      requestId,
      billingStatus: "unknown",
      phpAmount: "0.03872",
      usdAmount: "0.00055",
    }]);
    assert.equal(calls[0].values[0], userA);
    assert.equal(calls[0].text.includes("list_eligible_mia_reservations"), true);
    assert.equal(calls[0].text.includes("reconcile_unknown_reservation"), false);
    assert.equal(/\b(update|insert|delete)\b/i.test(calls[0].text), false);

    rows = [{
      request_id: requestId,
      attempt_number: 1,
      billing_status: "unknown",
      php_amount: 0.03872,
      usd_amount: "0.00055",
    }];
    await assert.rejects(
      () => listEligibleUnknownReservations(userA),
      (error: unknown) => error instanceof MiaServiceError && error.kind === "unavailable",
    );
  });
});

describe("reservation amount display", () => {
  it("removes only trailing fractional zeros from decimal strings", () => {
    assert.equal(canonicalDecimalText("0.03872000000000000000"), "0.03872");
    assert.equal(canonicalDecimalText("0.00055000000000000000"), "0.00055");
    assert.equal(canonicalDecimalText("0"), "0");
    assert.equal(canonicalDecimalText("0.000"), "0");
    assert.equal(canonicalDecimalText("12"), "12");
    assert.equal(canonicalDecimalText("12.000"), "12");
    assert.equal(canonicalDecimalText("1.25010"), "1.2501");
    assert.equal(canonicalDecimalText("0.00000000000000000010"), "0.0000000000000000001");
    assert.notEqual(
      canonicalDecimalText("0.00000000000000000010"),
      String(Number("0.00000000000000000010")),
    );
  });
});

describe("MIA authenticated actions", () => {
  it("requires AAL2 and uses only the session owner", async () => {
    for (const candidate of [null, protectedUser(userA, { assurance: "aal1" }), protectedUser(userA, { verifiedTotp: false })]) {
      actionCalls.length = 0;
      session = candidate;
      await assert.rejects(() => initializeMiaSummaryAction({ evidenceId, ownerId: forgedOwner }));
      await assert.rejects(() => generateMiaSummaryAction({ evidenceId, ownerId: forgedOwner }));
      await assert.rejects(() => askMiaQuestionAction({ evidenceId, question: "What is spend?", ownerId: forgedOwner }));
      await assert.rejects(() => readMiaContextAction({ evidenceId, ownerId: forgedOwner }));
      await assert.rejects(() => reconcileMiaReservationAction({
        requestId,
        phpAmount: "0.03872",
        usdAmount: "0.00055",
        ownerId: forgedOwner,
      }));
      await assert.rejects(() => listEligibleReservationsAction());
      assert.equal(actionCalls.length, 0);
    }

    session = protectedUser(userA);
    const initialized = await initializeMiaSummaryAction({
      evidenceId,
      ownerId: forgedOwner,
      sourceText: csv,
    });
    assert.equal(initialized.ok, true);
    assert.equal(actionCalls[0].args[0], userA);
    assert.equal(JSON.stringify(actionCalls[0].args).includes(forgedOwner), false);
    assert.equal(JSON.stringify(actionCalls[0].args).includes("SECRET-CSV-ROW"), false);
    assert.equal(actionCalls.some((call) => call.method === "dispatch"), false);

    actionCalls.length = 0;
    const firstLoad = await initializeMiaSummaryAction({ evidenceId });
    const refresh = await initializeMiaSummaryAction({ evidenceId });
    assert.equal(firstLoad.ok, true);
    assert.equal(refresh.ok, true);
    assert.equal(actionCalls.filter((call) => call.method === "dispatch").length, 0);
    assert.equal(actionCalls.filter((call) => call.method === "summary").length, 2);
  });

  it("keeps the upload when summary initialization fails and recovers the same summary", async () => {
    summaryError = new Error("summary insert failed");
    const uploaded = await uploadEvidenceAction(uploadForm());
    assert.equal(uploaded.ok, true);
    if (uploaded.ok) {
      assert.equal(uploaded.evidence.id, evidenceId);
      assert.equal(uploaded.mia.initialized, false);
    }
    assert.equal(actionCalls.some((call) => call.method === "insert"), true);
    assert.equal(actionCalls.some((call) => call.method === "dispatch"), false);

    summaryError = null;
    actionCalls.length = 0;
    const recovered = await initializeMiaSummaryAction({ evidenceId, ownerId: forgedOwner });
    assert.equal(recovered.ok, true);
    if (recovered.ok) {
      assert.equal(recovered.request.resultCode, "unchanged");
      assert.equal(recovered.request.availability, "awaiting_provider");
    }
    assert.equal(actionCalls[0].args[0], userA);
  });

  it("loads the database exchange and does not treat a new question as the stored answer", async () => {
    const first = await askMiaQuestionAction({ evidenceId, question: "What is spend?", ownerId: forgedOwner, previousAnswer: "forged" });
    const second = await askMiaQuestionAction({ evidenceId, question: "What is revenue?" });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    const questionCalls = actionCalls.filter((call) => call.method === "question");
    assert.equal(questionCalls.length, 2);
    assert.notEqual(questionCalls[0].args[3], questionCalls[1].args[3]);
    if (first.ok && second.ok) {
      assert.equal(first.request.classification, null);
      assert.deepEqual(first.exchange, storedExchange);
      assert.equal(first.exchange.answer === "forged", false);
      assert.equal(second.request.requestType, "evidence_question");
      assert.notEqual(second.request.requestType, "performance_summary");
    }

    const context = await readMiaContextAction({ evidenceId });
    assert.equal(context.ok, true);
    if (context.ok) {
      assert.equal(context.context.exchange.question, "Earlier question?");
      assert.equal(context.context.parserVersion, PARSER_VERSION);
      assert.equal(JSON.stringify(context.context).includes("SECRET-CSV-ROW"), false);
    }
  });

  it("rejects another owner's evidence and reports an unsupported question without a provider call", async () => {
    const missing = await askMiaQuestionAction({ evidenceId: "22222222-2222-4222-8222-222222222222", question: "What is spend?" });
    assert.equal(missing.ok, false);
    if (!missing.ok) {
      assert.equal(missing.kind, "not_found");
    }
    assert.equal(actionCalls.some((call) => call.method === "question"), false);

    const refused = await askMiaQuestionAction({ evidenceId, question: "Why did spend change?" });
    assert.equal(refused.ok, true);
    if (refused.ok) {
      assert.equal(refused.request.classification?.code, "causal_claim");
      assert.equal(refused.request.classification?.persisted, true);
      assert.equal(refused.request.state, "refused");
      assert.equal(refused.request.renderedText, "MIA cannot explain a cause from this evidence.");
      assert.equal(refused.request.classification?.message, refused.request.renderedText);
      assert.deepEqual(refused.exchange, storedExchange);
      assert.notEqual(refused.exchange.answer, refused.request.renderedText);
      assert.notEqual(refused.request.requestType, "performance_summary");
    }
    assert.equal(JSON.stringify(actionCalls).includes("claim_mia_dispatch"), false);
  });

  it("dispatches a summary only from the explicit action while it is validating", async () => {
    const generated = await generateMiaSummaryAction({ evidenceId, ownerId: forgedOwner });
    assert.equal(generated.ok, true);
    if (generated.ok) {
      assert.equal(generated.request.state, "processing");
    }
    assert.equal(actionCalls[0].args[0], userA);
    assert.equal(actionCalls.filter((call) => call.method === "dispatch").length, 1);

    for (const state of ["processing", "completed", "failed", "timed_out", "reconciliation_required", "refused"]) {
      actionCalls.length = 0;
      summaryState = state;
      const again = await generateMiaSummaryAction({ evidenceId });
      assert.equal(again.ok, true);
      if (again.ok) {
        assert.equal(again.request.state, state);
      }
      assert.equal(actionCalls.some((call) => call.method === "dispatch"), false);
    }

    const other = await generateMiaSummaryAction({ evidenceId: "22222222-2222-4222-8222-222222222222" });
    assert.equal(other.ok, false);
    if (!other.ok) {
      assert.equal(other.kind, "not_found");
    }
  });

  it("reconciles a reservation for the session owner and passes decimal strings unchanged", async () => {
    const first = await reconcileMiaReservationAction({
      requestId,
      phpAmount: "0.03872",
      usdAmount: "0.00055",
      ownerId: forgedOwner,
    });
    const second = await reconcileMiaReservationAction({
      requestId,
      phpAmount: "0.03872",
      usdAmount: "0.00055",
    });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (first.ok && second.ok) {
      assert.equal(first.alreadyRecorded, false);
      assert.equal(second.alreadyRecorded, true);
      assert.equal(first.reasonCode, "owner_authorized_unknown_billing_release");
      assert.equal(first.phpSpent, "0");
      assert.equal(first.usdSpent, "0");
    }
    const reconciliations = actionCalls.filter((call) => call.method === "reconcile");
    assert.equal(reconciliations.length, 2);
    assert.deepEqual(reconciliations[0].args, [userA, requestId, "0.03872", "0.00055"]);
    assert.equal(JSON.stringify(reconciliations).includes(forgedOwner), false);
    assert.equal(JSON.stringify(actionCalls).includes("billing_status"), false);
    assert.equal(JSON.stringify(actionCalls).includes("outcome"), false);

    const missing = await reconcileMiaReservationAction({
      requestId: "22222222-2222-4222-8222-222222222222",
      phpAmount: "0.03872",
      usdAmount: "0.00055",
    });
    assert.equal(missing.ok, false);
    if (!missing.ok) {
      assert.equal(missing.kind, "not_found");
    }
    const invalid = await reconcileMiaReservationAction({
      requestId,
      phpAmount: "0.03872 ",
      usdAmount: "0.00055",
    });
    assert.equal(invalid.ok, false);
    if (!invalid.ok) {
      assert.equal(invalid.kind, "validation");
    }
  });

  it("lists the session owner's exact amounts and ignores a forged owner", async () => {
    rows = [{
      request_id: requestId,
      attempt_number: 1,
      billing_status: "unknown",
      php_amount: "0.03872000000000000000",
      usd_amount: "0.00055000000000000000",
    }];
    const listed = await listEligibleReservationsAction();
    assert.equal(listed.ok, true);
    if (listed.ok) {
      assert.equal(listed.reservations[0].phpAmount, "0.03872");
      assert.equal(listed.reservations[0].usdAmount, "0.00055");
    }
    assert.equal(calls[0].values[0], userA);
    assert.equal(JSON.stringify(calls[0].values).includes(forgedOwner), false);

    const released = await reconcileMiaReservationAction({
      requestId,
      phpAmount: "9.99",
      usdAmount: "1.00",
      ownerId: forgedOwner,
    });
    assert.equal(released.ok, true);
    const reconciliation = actionCalls.filter((call) => call.method === "reconcile").at(-1);
    assert.deepEqual(reconciliation?.args, [userA, requestId, "9.99", "1.00"]);
  });

  it("does not reconcile when the lookup fails", async () => {
    replaceMiaDatabase(() => async () => {
      throw new Error("lookup failed");
    });
    const listed = await listEligibleReservationsAction();
    assert.equal(listed.ok, false);
    if (!listed.ok) {
      assert.equal(listed.kind, "unavailable");
    }
    assert.equal(actionCalls.some((call) => call.method === "reconcile"), false);
    installDatabase();
  });
});

function evidenceFingerprint(question: string) {
  return {
    parserVersion: PARSER_VERSION,
    calculationVersion: CALCULATION_VERSION,
    requestType: "evidence_question" as const,
    evidenceId,
    question,
  };
}

function openRow(resultCode: string) {
  return { request_id: requestId, state: "validating", result_code: resultCode };
}

function readRow(
  state: string,
  renderedText: string | null,
  requestType: "performance_summary" | "evidence_question" = "evidence_question",
) {
  return {
    request_id: requestId,
    request_type: requestType,
    state,
    rendered_text: renderedText,
    failure_category: null,
    created_at: new Date("2024-03-02T00:00:00.000Z"),
    completed_at: state === "refused" ? new Date("2024-03-02T00:00:01.000Z") : null,
  };
}

function refusalRow(resultCode: "refused" | "unchanged", renderedText: string) {
  return {
    request_id: requestId,
    state: "refused",
    result_code: resultCode,
    rendered_text: renderedText,
  };
}

function joinedSql(): string {
  return calls.map((call) => `${call.text} ${call.values.join(" ")}`).join("\n");
}

function installDatabase(): void {
  replaceMiaDatabase(() => async (strings, ...values) => {
    const call = { text: strings.join(" "), values: [...values] };
    calls.push(call);
    if (call.text.includes("refuse_validated_mia_question") && refuseFailures > 0) {
      refuseFailures -= 1;
      throw new Error("connection reset");
    }
    const next = rows.shift();
    if (Array.isArray(next)) {
      return next;
    }
    return next === undefined ? [] : [next];
  });
}

function installActions(): void {
  replaceEvidenceActionDependencies({
    session: async () => gate(session),
    evidence: {
      async insertEvidence(ownerId) {
        actionCalls.push({ method: "insert", args: [ownerId] });
        return detail();
      },
      async listEvidence() {
        return [];
      },
      async readEvidence(ownerId, id) {
        actionCalls.push({ method: "read", args: [ownerId, id] });
        if (ownerId === userA && id === evidenceId) {
          return detail();
        }
        return null;
      },
      async deleteEvidence() {
        return false;
      },
    },
  });
  replaceMiaOperations({
    async ensurePerformanceSummary(ownerId, selected) {
      actionCalls.push({ method: "summary", args: [ownerId, selected.id, selected.summary] });
      if (summaryError) {
        throw summaryError;
      }
      return { ...request("performance_summary", summaryError ? "created" : "unchanged"), state: summaryState };
    },
    async openEvidenceQuestion(ownerId, selected, question, idempotencyKey) {
      actionCalls.push({ method: "question", args: [ownerId, selected.id, question, idempotencyKey] });
      const classified = classifyQuestion(question);
      if (!classified) {
        return { ...request("evidence_question", "created"), classification: null } satisfies MiaQuestionRecord;
      }
      return {
        ...request("evidence_question", "refused"),
        state: "refused",
        availability: "refused",
        renderedText: classified.message,
        completedAt: "2024-03-02T00:00:01.000Z",
        classification: { code: classified.code, message: classified.message, persisted: true },
      } satisfies MiaQuestionRecord;
    },
    async dispatchValidatedRequest(ownerId, _selected, current) {
      actionCalls.push({ method: "dispatch", args: [ownerId, current.requestId, current.state] });
      return { ...current, state: "processing" };
    },
    async reconcileUnknownReservation(ownerId, id, phpAmount, usdAmount) {
      actionCalls.push({ method: "reconcile", args: [ownerId, id, phpAmount, usdAmount] });
      if (ownerId !== userA || id !== requestId) {
        throw new MiaServiceError("not_found", "The MIA request was not found.");
      }
      return {
        alreadyRecorded: actionCalls.filter((call) => call.method === "reconcile").length > 1,
        phpReserved: "0",
        usdReserved: "0",
        phpSpent: "0",
        usdSpent: "0",
      };
    },
    async readMiaContext(ownerId, id) {
      actionCalls.push({ method: "context", args: [ownerId, id] });
      if (ownerId !== userA || id !== evidenceId) {
        return null;
      }
      return {
        evidenceId,
        parserVersion: PARSER_VERSION,
        calculationVersion: CALCULATION_VERSION,
        summary,
        exchange: storedExchange,
      };
    },
  });
}

function request(requestType: MiaRequestRecord["requestType"], resultCode: MiaRequestRecord["resultCode"]): MiaRequestRecord {
  return {
    requestId,
    requestType,
    state: "validating",
    resultCode,
    availability: "awaiting_provider",
    renderedText: null,
    failureCategory: null,
    createdAt: null,
    completedAt: null,
  };
}

function detail() {
  return {
    id: evidenceId,
    createdAt: "2024-03-01T00:00:00.000Z",
    parserVersion: PARSER_VERSION,
    calculationVersion: CALCULATION_VERSION,
    summary,
  };
}

function gate(snapshot: Snapshot | null): Snapshot {
  const context: AuthContext = snapshot
    ? {
        hasSession: true,
        emailConfirmed: snapshot.emailConfirmed,
        assurance: snapshot.assurance,
        verifiedTotp: snapshot.verifiedTotp,
      }
    : { hasSession: false, emailConfirmed: false, assurance: null, verifiedTotp: false };
  const decision = accessDecision(context, "/");
  if (!decision.allow || !snapshot) {
    throw Object.assign(new Error("redirect"), { redirectTo: decision.redirectTo });
  }
  return snapshot;
}

function protectedUser(userId: string, overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    userId,
    email: `${userId}@example.com`,
    emailConfirmed: true,
    assurance: "aal2",
    verifiedTotp: true,
    ...overrides,
  };
}

function uploadForm(): FormData {
  const data = new FormData();
  data.set("file", new File([
    "date,campaign,channel,spend,impressions,clicks\n2024-02-01,Spring,Search,10.00,9,3\n",
  ], "campaign.csv", { type: "text/csv" }));
  data.set("currency", "USD");
  return data;
}
