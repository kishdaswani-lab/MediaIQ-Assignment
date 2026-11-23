import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { CALCULATION_VERSION, PARSER_VERSION, type EvidenceSummary } from "@/server/evidence/types";
import { buildEvidencePacket, renderMiaAnswer } from "./engine";
import {
  MIA_INPUT_FRAMING_UNCERTAINTY,
  MIA_MAX_INPUT_TOKENS,
  MIA_MODEL,
  assessMiaInput,
  inputLimitMessage,
  miaModelRequest,
  useMiaProviderClient,
  type MiaProviderClient,
} from "./provider";
import {
  ambiguousQuestionMessage,
  selectionRefusalMessages,
  selectQuestionContext,
  unsupportedQuestionMessage,
  type SelectionRefusalCode,
} from "./selection";
import { dispatchValidatedRequest, replaceMiaDatabase, type MiaRequestRecord } from "./service";

const evidenceId = "629fd841-067c-40dd-a89e-511c5b8dd901";
const ownerId = "47f8e2d2-e721-448a-bbac-f9460eb2ad33";
const spendQuestion = "What is the total spend across all campaigns?";
const calls: { text: string; values: unknown[] }[] = [];
const responses: unknown[][] = [];

afterEach(() => {
  calls.length = 0;
  responses.length = 0;
  useMiaProviderClient(null);
  replaceMiaDatabase();
});

describe("question-specific evidence selection", () => {
  it("selects only the file-level spend reference for the total spend question", () => {
    const selected = selectQuestionContext(evidenceId, spendFile(), spendQuestion);
    assert.equal(selected.status, "selected");
    if (selected.status !== "selected") {
      return;
    }
    assert.equal(selected.references.length, 1);
    assert.deepEqual(selected.references[0], {
      metricId: "spend",
      dimension: "file",
      dimensionValue: "",
      unit: "USD",
      period: { start: "2026-11-01", end: "2026-11-03" },
      evidenceId,
    });
    assert.equal(selected.packet.available.length, 1);
    const available = selected.packet.available[0];
    assert.equal(available?.status, "available");
    if (available?.status === "available") {
      assert.equal(available.display, "$25.30 USD");
    }
    const full = buildEvidencePacket(evidenceId, spendFile());
    assert.ok(full.available.length > selected.references.length);
  });

  it("fits the selected spend question inside the serialized body ceiling", () => {
    const selected = selectQuestionContext(evidenceId, spendFile(), spendQuestion);
    assert.equal(selected.status, "selected");
    if (selected.status !== "selected") {
      return;
    }
    const assessment = assessMiaInput(selected.packet, selected.question);
    const body = miaModelRequest(selected.packet, selected.question);
    assert.equal(typeof body, "string");
    assert.equal(assessment.withinCeiling, true);
    assert.equal(assessment.body, 1640);
    assert.equal(assessment.instructions, 227);
    assert.equal(assessment.question, 45);
    assert.equal(assessment.evidence, 131);
    assert.equal(assessment.envelope, 1210);
    assert.equal(assessment.body + MIA_INPUT_FRAMING_UNCERTAINTY, 1896);
    assert.equal(assessment.body + MIA_INPUT_FRAMING_UNCERTAINTY <= MIA_MAX_INPUT_TOKENS, true);
    assert.ok(assessment.body <= MIA_MAX_INPUT_TOKENS - MIA_INPUT_FRAMING_UNCERTAINTY);
    const input = JSON.parse(body ?? "").input as string;
    assert.match(input, /period\t2026-11-01\t2026-11-03/);
    assert.match(input, /currencies\tUSD/);
    assert.match(input, /spend\tfile\t\tUSD/);
    assert.equal(referenceLines(input).length, 1);
    assert.equal(input.includes("25.30"), false);
    assert.equal(input.includes("Campaign A"), false);
  });

  it("renders the saved file spend and rejects a metric that was not selected", () => {
    const summary = spendFile();
    const selected = selectQuestionContext(evidenceId, summary, spendQuestion);
    assert.equal(selected.status, "selected");
    if (selected.status !== "selected") {
      return;
    }
    const answer = renderMiaAnswer({
      evidenceId,
      summary,
      question: spendQuestion,
      response: { facts: selected.references, comparisons: [] },
      allowedReferences: selected.references,
    });
    assert.equal(answer.status, "answered");
    assert.deepEqual(answer.sentences, ["Spend for the file in USD was $25.30 USD."]);

    const revenue = { ...selected.references[0], metricId: "revenue" as const };
    const rejected = renderMiaAnswer({
      evidenceId,
      summary,
      question: spendQuestion,
      response: { facts: [revenue], comparisons: [] },
      allowedReferences: selected.references,
    });
    assert.equal(rejected.status, "refused");
    assert.deepEqual(rejected.sentences, []);
    assert.equal(rejected.refusals[0]?.code, "invalid_response");
    assert.equal(JSON.stringify(rejected).includes("145.00"), false);
  });

  it("selects one channel spend reference when the channel name is unambiguous", () => {
    const selected = selectQuestionContext(evidenceId, scopedSummary(), "What is the spend for Meta?");
    assert.equal(selected.status, "selected");
    if (selected.status !== "selected") {
      return;
    }
    assert.equal(selected.references.length, 1);
    assert.equal(selected.references[0]?.dimension, "channel");
    assert.equal(selected.references[0]?.dimensionValue, "Meta");
    assert.equal(selected.references[0]?.metricId, "spend");
    assert.equal(selected.references[0]?.unit, "USD");
    assert.deepEqual(selected.packet.channels, ["Meta"]);
    assert.deepEqual(selected.packet.campaigns, []);
  });

  it("selects one campaign spend reference and keeps the campaign name case", () => {
    const selected = selectQuestionContext(evidenceId, scopedSummary(), "What is the spend for Campaign A?");
    assert.equal(selected.status, "selected");
    if (selected.status !== "selected") {
      return;
    }
    assert.equal(selected.references.length, 1);
    assert.equal(selected.references[0]?.dimension, "campaign");
    assert.equal(selected.references[0]?.dimensionValue, "Campaign A");
    const available = selected.packet.available[0];
    assert.equal(available?.status, "available");
    if (available?.status === "available") {
      assert.equal(available.display, "$10.30 USD");
    }

    const mismatched = selectQuestionContext(evidenceId, scopedSummary(), "What is the spend for campaign a?");
    assert.equal(mismatched.status, "refused");
    if (mismatched.status === "refused") {
      assert.equal(mismatched.message, unsupportedQuestionMessage);
    }
  });

  it("refuses mixed-currency aggregation before a provider call", async () => {
    const selected = selectQuestionContext(evidenceId, mixedCurrencyFile(), spendQuestion);
    assert.equal(selected.status, "refused");
    if (selected.status === "refused") {
      assert.equal(selected.code, "incompatible_currency");
      assert.equal(selected.message, "Those amounts are not in the same currency, so they stay separate.");
    }
    const result = await dispatchQuestion(mixedCurrencyFile(), spendQuestion);
    assert.equal(result.state, "refused");
    assert.equal(result.renderedText, selectionRefusalMessages.incompatible_currency);
    assertSelectionPersisted("incompatible_currency");
  });

  it("refuses a missing metric before a provider call", async () => {
    const summary = spendFile();
    delete summary.conversions;
    const selected = selectQuestionContext(evidenceId, summary, "What is the conversions for the file?");
    assert.equal(selected.status, "refused");
    if (selected.status === "refused") {
      assert.equal(selected.code, "missing_source");
      assert.match(selected.message, /not included/);
    }
    const result = await dispatchQuestion(summary, "What is the conversions for the file?");
    assert.equal(result.state, "refused");
    assert.equal(result.renderedText, selectionRefusalMessages.missing_source);
    assertSelectionPersisted("missing_source");
  });

  it("refuses an ambiguous or unsupported question and does not send the full packet", async () => {
    const ambiguous = selectQuestionContext(evidenceId, collidingSummary(), "What is the spend for Meta?");
    assert.equal(ambiguous.status, "refused");
    if (ambiguous.status === "refused") {
      assert.equal(ambiguous.code, "ambiguous_question");
      assert.equal(ambiguous.message, ambiguousQuestionMessage);
    }
    const unsupported = selectQuestionContext(evidenceId, scopedSummary(), "Which channel has more spend?");
    assert.equal(unsupported.status, "refused");
    if (unsupported.status === "refused") {
      assert.equal(unsupported.code, "unsupported_question");
      assert.equal(unsupported.message, unsupportedQuestionMessage);
    }
    const full = buildEvidencePacket(evidenceId, scopedSummary());
    assert.ok(full.available.length > 1);
    const result = await dispatchQuestion(scopedSummary(), "Which channel has more spend?");
    assert.equal(result.renderedText, unsupportedQuestionMessage);
    assert.equal(JSON.stringify(result).includes("\"metricId\":\"spend\""), false);
    assertSelectionPersisted("unsupported_question");
  });

  it("refuses a shared channel and campaign name and does not infer an explicit dimension", async () => {
    const summary = collidingSummary();
    const selected = selectQuestionContext(evidenceId, summary, "What is the spend for Meta?");
    assert.equal(selected.status, "refused");
    if (selected.status === "refused") {
      assert.equal(selected.code, "ambiguous_question");
      assert.equal(selected.message, ambiguousQuestionMessage);
    }
    for (const question of [
      "What is the spend for the channel Meta?",
      "What is the spend for the campaign Meta?",
    ]) {
      const explicit = selectQuestionContext(evidenceId, summary, question);
      assert.equal(explicit.status, "refused");
      if (explicit.status === "refused") {
        assert.equal(explicit.code, "unsupported_question");
      }
    }
    const channelOnly = selectQuestionContext(evidenceId, scopedSummary(), "What is the spend for Meta?");
    assert.equal(channelOnly.status, "selected");
    if (channelOnly.status === "selected") {
      assert.equal(channelOnly.references.length, 1);
      assert.equal(channelOnly.references[0]?.dimension, "channel");
      assert.equal(channelOnly.references[0]?.dimensionValue, "Meta");
    }
    const result = await dispatchQuestion(summary, "What is the spend for Meta?");
    assert.equal(result.state, "refused");
    assert.equal(result.renderedText, ambiguousQuestionMessage);
    assertSelectionPersisted("ambiguous_question");
    assert.equal(calls.some((call) => call.values.includes("What is the spend for Meta?")), false);
  });

  it("fails an oversized selected context before reservation and provider dispatch", async () => {
    const campaignName = `Campaign ${"y".repeat(2500)}`;
    const summary = spendFile();
    summary.campaigns = [{
      name: campaignName,
      impressions: "1",
      clicks: "1",
      ctr: { kind: "omitted", reason: "not_exact" },
      currencies: [{ currency: "USD", spend: "4.00", cpc: { kind: "omitted", reason: "not_exact" } }],
    }];
    installDatabase([
      [{ result_code: "failed" }],
      [stored("failed", null, inputLimitMessage)],
    ]);
    let called = 0;
    useMiaProviderClient(throwingClient(() => {
      called += 1;
    }));
    const result = await dispatchValidatedRequest(
      ownerId,
      identity(summary),
      request("evidence_question"),
      `What is the spend for ${campaignName}?`,
    );
    assert.equal(called, 0);
    assert.equal(result.state, "failed");
    assert.equal(result.failureCategory, inputLimitMessage);
    assert.match(joined(), /fail_mia_request_before_dispatch/);
    assert.equal(joined().includes("claim_mia_dispatch"), false);
  });

  it("keeps the automatic summary on the full evidence packet", async () => {
    const summary = scopedSummary();
    const full = buildEvidencePacket(evidenceId, summary);
    let summaryBody = "";
    installDatabase([
      [{ authorized: true, provider: "openai", model: MIA_MODEL }],
      [],
      [stored("completed", "{\"contextVersion\":\"mia-panel-1\"}", null)],
    ]);
    useMiaProviderClient({
      respond: async (input) => {
        summaryBody = input.body;
        return {
          disposition: "completed",
          output: { facts: [full.available[0]?.reference], comparisons: [] },
          usage: { inputTokens: 20, cachedInputTokens: 0, outputTokens: 8, otherBillableTokens: null },
          latencyMs: 5,
        };
      },
    });
    const result = await dispatchValidatedRequest(
      ownerId,
      identity(summary),
      request("performance_summary"),
      null,
    );
    assert.equal(result.state, "completed");
    const input = JSON.parse(summaryBody).input as string;
    assert.equal(referenceLines(input).length, full.available.length);
    assert.ok(full.available.length > 1);

    calls.length = 0;
    responses.length = 0;
    installDatabase([
      [{ result_code: "failed" }],
      [stored("failed", null, inputLimitMessage)],
    ]);
    let called = 0;
    useMiaProviderClient(throwingClient(() => {
      called += 1;
    }));
    const oversized = await dispatchValidatedRequest(
      ownerId,
      identity(wideSummary()),
      request("performance_summary"),
      null,
    );
    assert.equal(called, 0);
    assert.equal(oversized.state, "failed");
    assert.equal(oversized.failureCategory, inputLimitMessage);
    assert.equal(joined().includes("claim_mia_dispatch"), false);
  });

  it("leaves the previous exchange untouched when selection refuses or a later attempt fails", async () => {
    const refused = await dispatchQuestion(scopedSummary(), "Which channel has more spend?");
    assert.equal(refused.state, "refused");
    assertSelectionPersisted("unsupported_question");
    assert.equal(joined().includes("latest_question"), false);
    assert.equal(joined().includes("latest_answer"), false);

    calls.length = 0;
    responses.length = 0;
    installDatabase([
      [{ authorized: true, provider: "openai", model: MIA_MODEL }],
      [],
      [stored("failed", null, null)],
    ]);
    useMiaProviderClient({
      respond: async () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        throw error;
      },
    });
    const failed = await dispatchValidatedRequest(
      ownerId,
      identity(spendFile()),
      request("evidence_question"),
      spendQuestion,
    );
    assert.equal(failed.state, "failed");
    const recorded = calls.find((call) => call.text.includes("record_mia_attempt_outcome"));
    assert.ok(recorded);
    assert.equal(recorded.values[14], null);
    assert.equal(recorded.values[15], null);
  });
});

function referenceLines(input: string): string[] {
  return input.split("\n").filter((line) => /^[a-z_]+\t(file|channel|campaign)\t/.test(line));
}

function assertSelectionPersisted(code: SelectionRefusalCode): void {
  const persisted = calls.find((call) => call.text.includes("refuse_mia_selection"));
  assert.ok(persisted);
  assert.equal(persisted.values[3], code);
  assert.equal(joined().includes("claim_mia_dispatch"), false);
  assert.equal(joined().includes("record_mia_attempt_outcome"), false);
  assert.equal(calls.some((call) => call.text.includes("refuse_validated_mia_question")), false);
}

async function dispatchQuestion(summary: EvidenceSummary, question: string): Promise<MiaRequestRecord> {
  calls.length = 0;
  responses.length = 0;
  let sentence = "";
  replaceMiaDatabase(() => async (strings, ...values) => {
    const text = strings.join(" ");
    calls.push({ text, values: [...values] });
    if (text.includes("refuse_mia_selection")) {
      const code = values[3];
      if (typeof code !== "string" || !(code in selectionRefusalMessages)) {
        throw new Error("selection refusal code was not controlled");
      }
      sentence = selectionRefusalMessages[code as SelectionRefusalCode];
      return [{
        request_id: "33333333-3333-4333-8333-333333333333",
        state: "refused",
        result_code: "refused",
        rendered_text: sentence,
      }];
    }
    if (text.includes("read_mia_request")) {
      return [{
        request_id: "33333333-3333-4333-8333-333333333333",
        request_type: "evidence_question",
        state: "refused",
        rendered_text: sentence,
        failure_category: null,
        created_at: null,
        completed_at: new Date("2026-11-22T00:00:00.000Z"),
      }];
    }
    throw new Error("selection refusal used an unexpected database call");
  });
  // The provider test double is not a React hook.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  useMiaProviderClient(throwingClient(() => {
    throw new Error("provider was called");
  }));
  return dispatchValidatedRequest(ownerId, identity(summary), request("evidence_question"), question);
}

function throwingClient(onCall: () => void): MiaProviderClient {
  return {
    respond: async () => {
      onCall();
      throw new Error("provider was called");
    },
  };
}

function installDatabase(queue: unknown[][]): void {
  responses.push(...queue);
  replaceMiaDatabase(() => async (strings, ...values) => {
    calls.push({ text: strings.join(" "), values: [...values] });
    return responses.shift() ?? [];
  });
}

function joined(): string {
  return calls.map((call) => call.text).join("\n");
}

function request(requestType: MiaRequestRecord["requestType"]): MiaRequestRecord {
  return {
    requestId: "33333333-3333-4333-8333-333333333333",
    requestType,
    state: "validating",
    resultCode: "created",
    availability: "awaiting_provider",
    renderedText: null,
    failureCategory: null,
    createdAt: null,
    completedAt: null,
  };
}

function stored(state: string, renderedText: string | null, failureCategory: string | null) {
  return {
    request_id: "33333333-3333-4333-8333-333333333333",
    request_type: "evidence_question",
    state,
    rendered_text: renderedText,
    failure_category: failureCategory,
    created_at: null,
    completed_at: null,
  };
}

function identity(summary: EvidenceSummary) {
  return {
    id: evidenceId,
    parserVersion: PARSER_VERSION,
    calculationVersion: CALCULATION_VERSION,
    summary,
  };
}

function spendFile(): EvidenceSummary {
  return {
    calculationVersion: CALCULATION_VERSION,
    parserVersion: PARSER_VERSION,
    currencySource: "column",
    period: { start: "2026-11-01", end: "2026-11-03" },
    impressions: "2700",
    clicks: "270",
    conversions: "13",
    ctr: { kind: "omitted", reason: "not_exact" },
    currencies: [{
      currency: "USD",
      spend: "25.30",
      revenue: "145.00",
      cpc: { kind: "omitted", reason: "not_exact" },
    }],
    channels: [],
    campaigns: [],
  };
}

function scopedSummary(): EvidenceSummary {
  const summary = spendFile();
  summary.channels = [
    group("Meta", "10.30"),
    group("Google", "15.00"),
  ];
  summary.campaigns = [
    group("Campaign A", "10.30"),
    group("Campaign B", "15.00"),
  ];
  return summary;
}

function mixedCurrencyFile(): EvidenceSummary {
  const summary = spendFile();
  summary.currencies = [
    { currency: "USD", spend: "25.30", cpc: { kind: "omitted", reason: "not_exact" } },
    { currency: "EUR", spend: "10.00", cpc: { kind: "omitted", reason: "not_exact" } },
  ];
  return summary;
}

function collidingSummary(): EvidenceSummary {
  const summary = spendFile();
  summary.channels = [group("Meta", "10.30")];
  summary.campaigns = [group("Meta", "10.30")];
  return summary;
}

function wideSummary(): EvidenceSummary {
  return {
    ...spendFile(),
    campaigns: Array.from({ length: 400 }, (_, index) => group(`Campaign ${index} ${"x".repeat(40)}`, "1.00")),
  };
}

function group(name: string, spend: string) {
  return {
    name,
    impressions: "100",
    clicks: "10",
    ctr: { kind: "omitted" as const, reason: "not_exact" as const },
    currencies: [{
      currency: "USD",
      spend,
      cpc: { kind: "omitted" as const, reason: "not_exact" as const },
    }],
  };
}
