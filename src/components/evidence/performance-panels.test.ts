import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { calculateEvidence } from "../../server/evidence/calculate-evidence";
import { parseCampaignCsv } from "../../server/evidence/parse-campaign-csv";
import type { EvidenceSummary, GroupTotals } from "../../server/evidence/types";
import {
  buildPerformancePanels,
  idempotencyKeyForSubmission,
  metricValues,
  questionAttemptDisposition,
  recoverTerminalResult,
  recoverUnsettledSubmission,
  serializeSubmission,
  submissionRecord,
  panelInsights,
  panelLayoutClass,
  presentSummary,
  questionRequestInput,
  questionStatus,
  selectSuggestedQuestion,
  summaryStatusCopy,
  visibleExchange,
  type SummaryRequestSnapshot,
} from "./performance-panels";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

describe("performance panels", () => {
  it("renders eligible panels from saved evidence and omits a trend series", () => {
    const parsed = parseCampaignCsv(csv(
      "date,campaign,channel,spend,impressions,clicks,conversions,revenue,currency",
      "2024-02-01,Spring,Search,10.00,100,10,2,25.00,USD",
      "2024-02-02,Spring,Social,5.00,40,4,1,8.00,USD",
      "2024-02-02,Autumn,Search,4.00,20,2,0,0,EUR",
    ));
    assert.equal(parsed.ok, true);
    if (!parsed.ok) {
      return;
    }
    const summary = calculateEvidence(parsed);
    const built = buildPerformancePanels(summary);
    const ids = built.panels.map((panel) => panel.id);

    assert.deepEqual(ids, [
      "performance_overview",
      "channel_performance",
      "campaign_performance",
      "conversion_funnel",
      "commercial_efficiency",
    ]);
    assert.deepEqual(built.omitted, [{
      id: "performance_trends",
      reason: "The saved summary stores a reporting period, not a date-by-date series.",
    }]);
    assert.equal(JSON.stringify(built).includes("2024-02-01"), true);
    assert.equal(JSON.stringify(built.panels).includes("audience"), false);
    assert.equal(built.panels.some((panel) => panel.charts.some((chart) => chart.id.includes("trend"))), false);

    const channel = built.panels.find((panel) => panel.id === "channel_performance");
    assert.ok(channel);
    assert.equal(channel.charts.some((chart) => chart.id === "channel-USD-spend"), true);
    assert.equal(channel.charts.some((chart) => chart.id === "channel-EUR-spend"), true);
    for (const chart of channel.charts) {
      const labels = chart.bars.map((bar) => bar.valueLabel).join(" ");
      assert.equal(labels.includes("USD") && labels.includes("EUR"), false);
    }
    assert.equal(channel.facts.some((fact) => fact.value === "0" && fact.term.includes("EUR") && fact.term.includes("revenue")), false);
  });

  it("does not invent revenue, conversions, or a zero rate", () => {
    const built = buildPerformancePanels(summary({
      clicks: "0",
      conversions: undefined,
      ctr: { kind: "omitted", reason: "zero_denominator" },
      currencies: [money("USD", "10.00", undefined, "zero")],
      channels: [group("Search", "10", "0", undefined, [money("USD", "10.00", undefined, "zero")])],
      campaigns: [group("Spring", "10", "0", undefined, [money("USD", "10.00", undefined, "zero")])],
    }));
    const funnel = built.panels.find((panel) => panel.id === "conversion_funnel");
    const efficiency = built.panels.find((panel) => panel.id === "commercial_efficiency");
    const channel = built.panels.find((panel) => panel.id === "channel_performance");

    assert.ok(funnel);
    assert.deepEqual(funnel.charts[0]?.bars.map((bar) => bar.label), ["Impressions", "Clicks"]);
    assert.equal(funnel.facts.some((fact) => fact.term === "Conversions"), false);
    assert.equal(efficiency, undefined);
    assert.ok(channel);
    assert.equal(channel.charts.some((chart) => chart.id.includes("revenue")), false);
    assert.equal(channel.facts.some((fact) => fact.term.includes("revenue")), false);
    assert.equal(channel.facts.some((fact) => fact.value === "0" && fact.term.includes("CPC")), false);
  });

  it("uses one summary request and does not treat pending text as a narrative", () => {
    const panels = buildPerformancePanels(summary()).panels;
    const request = snapshot("validating", null);
    const status = presentSummary(request, null, panels.map((panel) => panel.id));
    assert.equal(status.kind, "awaiting_provider");
    if (status.kind !== "awaiting_provider") {
      return;
    }
    assert.equal(status.requestId, "99999999-9999-4999-8999-999999999999");
    const overview = summaryStatusCopy(status, "performance_overview");
    const channel = summaryStatusCopy(status, "channel_performance");
    assert.equal(overview.body, channel.body);
    assert.equal(overview.body.includes("Generate AI Summary starts AI processing"), true);
    assert.equal(overview.suggestions.length, 0);
    const reconciliation = presentSummary({ ...request, state: "reconciliation_required", failureCategory: "unreconciled_billing" }, null, panels.map((panel) => panel.id));
    assert.equal(reconciliation.kind, "reconciliation_required");
    const failed = presentSummary({ ...request, state: "failed", failureCategory: "provider_rejected" }, null, panels.map((panel) => panel.id));
    assert.equal(failed.kind, "failed");
    if (failed.kind === "failed") {
      assert.equal(failed.message, "provider_rejected");
    }
    assert.equal(overview.body.includes("best"), false);
  });

  it("renders validated panel narratives and keeps a refusal out of those narratives", () => {
    const eligible = buildPerformancePanels(summary()).panels.map((panel) => panel.id);
    const document = JSON.stringify({
      contextVersion: "mia-panel-1",
      panels: [
        {
          panelId: "channel_performance",
          summary: "Search and Social spend are both recorded in USD.",
          observations: [{ text: "Search spend is the saved USD spend.", metrics: ["spend"] }],
          suggestedQuestions: ["What is Search spend?"],
        },
        {
          panelId: "performance_trends",
          summary: "No dated series is available.",
          observations: [],
          suggestedQuestions: ["What changed each day?"],
        },
      ],
    });
    const completed = presentSummary(snapshot("completed", document), null, eligible);
    assert.equal(completed.kind, "completed");
    if (completed.kind !== "completed") {
      return;
    }
    assert.equal(completed.requestId, snapshot("completed", document).requestId);
    assert.equal(summaryStatusCopy(completed, "channel_performance").body, "Search and Social spend are both recorded in USD.");
    assert.deepEqual(summaryStatusCopy(completed, "channel_performance").suggestions, ["What is Search spend?"]);
    assert.equal(summaryStatusCopy(completed, "performance_overview").suggestions.length, 0);
    assert.equal(completed.insights.some((insight) => insight.panelId === "performance_trends"), false);

    const refused = presentSummary(snapshot("refused", document, "refused"), null, eligible);
    assert.equal(refused.kind, "refused");
    if (refused.kind !== "refused") {
      return;
    }
    assert.equal(summaryStatusCopy(refused, "performance_overview").title, "Summary refusal");
    assert.equal(summaryStatusCopy(refused, "performance_overview").body, document);
    assert.equal(panelInsights(document, eligible)?.some((insight) => insight.summary.includes("caused")), false);
  });

  it("keeps the latest exchange when a question fails and reuses suggestion text without a request", () => {
    const previous = { question: "What is spend?", answer: "Spend is $10.00 USD.", exchangedAt: "2024-03-01T00:00:00.000Z" };
    assert.deepEqual(visibleExchange(previous, null, false), previous);
    assert.deepEqual(
      visibleExchange(previous, previous, true),
      previous,
    );
    const selected = selectSuggestedQuestion(["What is Search spend?"], "What is Search spend?");
    assert.deepEqual(selected, { text: "What is Search spend?", requestCreated: false });
    assert.equal(selectSuggestedQuestion(["What is Search spend?"], "Why did spend change?"), null);
    const openAttempt = submissionRecord("same-key", "What is Search spend?", false);
    assert.equal(idempotencyKeyForSubmission(openAttempt, "What is Search spend?"), "same-key");
    assert.equal(idempotencyKeyForSubmission(openAttempt, "What is revenue?"), null);
    assert.equal(idempotencyKeyForSubmission(submissionRecord("same-key", "What is Search spend?", true), "What is Search spend?"), null);
    assert.equal(questionAttemptDisposition({ ok: false, kind: "unavailable" }), "ambiguous");
    assert.equal(questionAttemptDisposition({ ok: true }), "settled");
    assert.equal(questionAttemptDisposition({ ok: false, kind: "conflict" }), "settled");
    const recovered = recoverUnsettledSubmission(serializeSubmission(openAttempt));
    assert.deepEqual(recovered, openAttempt);
    assert.equal(recoverUnsettledSubmission(serializeSubmission(submissionRecord("same-key", "What is Search spend?", true))), null);
    const terminal = serializeSubmission({
      key: "same-key",
      text: "What is Search spend?",
      settled: true,
      state: "failed",
      renderedText: null,
      failureCategory: "This evidence is too large to send within the 3,000-token input limit.",
    });
    assert.equal(recoverUnsettledSubmission(terminal), null);
    assert.deepEqual(recoverTerminalResult(terminal), {
      key: "same-key",
      text: "What is Search spend?",
      state: "failed",
      renderedText: null,
      failureCategory: "This evidence is too large to send within the 3,000-token input limit.",
    });

    const input = questionRequestInput(
      "11111111-1111-4111-8111-111111111111",
      selected?.text ?? "",
      "same-key",
    );
    assert.deepEqual(input, {
      evidenceId: "11111111-1111-4111-8111-111111111111",
      question: "What is Search spend?",
      idempotencyKey: "same-key",
    });
    assert.equal(Object.hasOwn(input, "panelId"), false);
    assert.equal(questionStatus({ state: "refused", renderedText: "MIA cannot recommend a campaign or budget change from this evidence.", failureCategory: null }).tone, "refused");
    assert.equal(questionStatus({ state: "validating", renderedText: null, failureCategory: null }).tone, "pending");
  });

  it("gives Guided and Advanced the same metric values and a stacking layout", () => {
    const built = buildPerformancePanels(summary());
    const again = buildPerformancePanels(summary());
    assert.deepEqual(built.panels.map(metricValues), again.panels.map(metricValues));
    assert.equal(panelLayoutClass.includes("grid"), true);
    assert.equal(panelLayoutClass.includes("lg:grid-cols-2"), true);
    assert.equal(panelLayoutClass.includes("w-["), false);

    const page = fs.readFileSync(path.join(root, "src/app/(app)/evidence/[id]/page.tsx"), "utf8");
    const view = fs.readFileSync(path.join(root, "src/components/evidence/performance-intelligence.tsx"), "utf8");
    assert.equal(page.includes("initializeMiaSummaryAction"), true);
    assert.equal(page.includes("dispatchValidatedRequest"), false);
    assert.equal(view.includes("generateMiaSummaryAction"), true);
    assert.equal(view.includes("Generate AI Summary"), true);
    assert.equal(page.includes("readMiaContextAction"), true);
    assert.equal(page.includes("askMiaQuestionAction"), false);
    assert.equal(view.includes("askMiaQuestionAction"), true);
    assert.equal(view.includes("claim_mia_dispatch"), false);
    assert.equal(view.includes("calculateEvidence"), false);
    assert.equal(view.includes("htmlFor"), true);
    assert.equal(view.includes("aria-label"), true);
    assert.equal(view.includes("disabled={pending"), true);
    assert.equal(view.includes("provider_request_id"), false);
    assert.equal(view.includes("http_status"), false);
    assert.equal(view.includes("transport_outcome"), false);
  });

  it("shows server failure categories without transport identifiers", () => {
    const refused = questionStatus({
      state: "refused",
      renderedText: "MIA cannot answer that question from this evidence.",
      failureCategory: null,
    });
    assert.equal(refused.tone, "refused");
    assert.equal(refused.message, "MIA cannot answer that question from this evidence.");

    const completed = questionStatus({
      state: "completed",
      renderedText: "Clicks for the file was 2.",
      failureCategory: null,
    });
    assert.equal(completed.tone, "completed");
    assert.equal(completed.message, "Clicks for the file was 2.");

    for (const category of ["provider_rejected", "timeout", "provider_response_unusable", "provider_unreachable"]) {
      const failed = questionStatus({ state: "failed", renderedText: null, failureCategory: category });
      assert.equal(failed.tone, "failed");
      assert.equal(failed.message, category);
      assert.equal(failed.message.includes("req_"), false);
      assert.equal(/\b[1-5][0-9]{2}\b/.test(failed.message), false);
    }
    assert.equal(questionStatus({ state: "timed_out", renderedText: null, failureCategory: "timeout" }).tone, "failed");
    assert.equal(questionStatus({ state: "processing", renderedText: null, failureCategory: null }).tone, "pending");

    const replayKey = idempotencyKeyForSubmission(
      { key: "same-attempt", text: "What is the clicks for the file?", settled: false },
      "What is the clicks for the file?",
    );
    assert.equal(replayKey, "same-attempt");
    assert.equal(idempotencyKeyForSubmission(
      { key: "same-attempt", text: "What is the clicks for the file?", settled: true },
      "What is the clicks for the file?",
    ), null);
  });
});

function snapshot(
  state: string,
  renderedText: string | null,
  availability: SummaryRequestSnapshot["availability"] = "awaiting_provider",
): SummaryRequestSnapshot {
  return {
    requestId: "99999999-9999-4999-8999-999999999999",
    requestType: "performance_summary",
    state,
    renderedText,
    failureCategory: null,
    availability,
  };
}

function summary(overrides: Partial<EvidenceSummary> = {}): EvidenceSummary {
  return {
    calculationVersion: "campaign-descriptive-1",
    parserVersion: "monday-csv-1",
    currencySource: "column",
    period: { start: "2024-02-01", end: "2024-02-02" },
    impressions: "100",
    clicks: "10",
    conversions: "2",
    ctr: { kind: "exact", value: "0.1" },
    currencies: [money("USD", "10.00", "25.00")],
    channels: [group("Search", "100", "10", "2", [money("USD", "10.00", "25.00")])],
    campaigns: [
      group("Spring", "60", "6", "1", [money("USD", "6.00", "15.00")]),
      group("Autumn", "40", "4", "1", [money("USD", "4.00", "10.00")]),
    ],
    ...overrides,
  };
}

function group(
  name: string,
  impressions: string,
  clicks: string,
  conversions: string | undefined,
  currencies: GroupTotals["currencies"],
): GroupTotals {
  return {
    name,
    impressions,
    clicks,
    conversions,
    ctr: clicks === "0" ? { kind: "omitted", reason: "zero_denominator" } : { kind: "exact", value: "0.1" },
    currencies,
  };
}

function money(
  currency: string,
  spend: string,
  revenue?: string,
  cpc: "exact" | "zero" = "exact",
): GroupTotals["currencies"][number] {
  return {
    currency,
    spend,
    revenue,
    cpc: cpc === "zero" ? { kind: "omitted", reason: "zero_denominator" } : { kind: "exact", value: "1.00" },
    ...(revenue ? { revenuePerSpend: { kind: "exact" as const, value: "2.5" } } : {}),
  };
}

function csv(...lines: string[]): Uint8Array {
  return new TextEncoder().encode(lines.join("\n"));
}
