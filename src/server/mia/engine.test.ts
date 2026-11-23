import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { replaceEvidenceActionDependencies } from "@/server/evidence/action-dependencies";
import { calculateEvidence } from "@/server/evidence/calculate-evidence";
import { parseCampaignCsv } from "@/server/evidence/parse-campaign-csv";
import { CALCULATION_VERSION, PARSER_VERSION, type EvidenceSummary } from "@/server/evidence/types";
import { readMiaEvidence } from "@/server/mia/access";
import {
  buildEvidencePacket,
  buildMiaPanelDocument,
  classifyQuestion,
  renderMiaAnswer,
  resolveFact,
  verifyComparison,
  type FactReference,
} from "@/server/mia/engine";

const miaRoot = path.dirname(fileURLToPath(import.meta.url));
const evidenceId = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const period = { start: "2024-02-01", end: "2024-02-01" };

afterEach(() => {
  replaceEvidenceActionDependencies();
});

describe("mia evidence resolution", () => {
  it("resolves saved facts and ignores a model-supplied amount", () => {
    const summary = channelSummary();
    const metaCpc = fact(summary, { metricId: "cpc", dimension: "channel", dimensionValue: "Meta", unit: "USD" });
    const resolved = resolveFact({ evidenceId, summary, reference: { ...metaCpc, amount: "999999" } as FactReference });
    assert.equal(resolved.status, "available");
    if (resolved.status === "available") {
      assert.equal(resolved.display, "$0.07 USD");
      assert.equal(resolved.display.includes("999999"), false);
    }
    const answer = renderMiaAnswer({
      evidenceId,
      summary,
      response: { facts: [{ ...metaCpc, amount: "999999", html: "<script>alert(1)</script>" }] },
    });
    assert.equal(answer.status, "answered");
    assert.equal(answer.sentences[0], "CPC for Meta in USD was $0.07 USD.");
    assert.equal(JSON.stringify(answer).includes("999999"), false);
    const document = buildMiaPanelDocument({
      evidenceId,
      summary,
      response: { facts: [{ ...metaCpc, amount: "999999" }], comparisons: [] },
    });
    assert.equal(document?.contextVersion, "mia-panel-1");
    assert.equal(JSON.stringify(document).includes("999999"), false);
    assert.equal(document?.panels.some((panel) => panel.panelId === "performance_trends"), false);
    const suggestion = document?.panels.flatMap((panel) => panel.suggestedQuestions)[0];
    assert.equal(typeof suggestion, "string");
    assert.equal(classifyQuestion(suggestion ?? ""), null);
    assert.equal(JSON.stringify(answer).includes("<script>"), false);
    assert.equal("html" in answer, false);
  });

  it("rejects an evidence id, metric, dimension, currency, or period that the summary does not support", () => {
    const summary = channelSummary();
    const base = fact(summary, { metricId: "cpc", dimension: "channel", dimensionValue: "Meta", unit: "USD" });
    assert.equal(resolveFact({ evidenceId, summary, reference: { ...base, evidenceId: otherId } }).status, "unavailable");
    assert.equal(
      resolveFact({
        evidenceId,
        summary,
        reference: { ...base, metricId: "profit" as FactReference["metricId"] },
      }).status,
      "unavailable",
    );
    assert.equal(
      code(resolveFact({ evidenceId, summary, reference: { ...base, dimensionValue: "Video" } })),
      "invalid_dimension",
    );
    assert.equal(code(resolveFact({ evidenceId, summary, reference: { ...base, unit: "EUR" } })), "incompatible_currency");
    assert.equal(
      code(resolveFact({ evidenceId, summary, reference: { ...base, period: { start: period.start, end: "2024-03-01" } } })),
      "incompatible_period",
    );
  });

  it("checks comparisons against the same displayed values and drops a false one", () => {
    const summary = channelSummary();
    const google = fact(summary, { metricId: "cpc", dimension: "channel", dimensionValue: "Google", unit: "USD" });
    const meta = fact(summary, { metricId: "cpc", dimension: "channel", dimensionValue: "Meta", unit: "USD" });
    const supported = verifyComparison({
      evidenceId,
      summary,
      comparison: { left: google, right: meta, relation: "gt" },
    });
    assert.equal(supported.status, "supported");
    const rejected = verifyComparison({
      evidenceId,
      summary,
      comparison: { left: meta, right: google, relation: "gt", amount: "1" } as never,
    });
    assert.equal(rejected.status, "rejected");
    if (rejected.status === "rejected") {
      assert.equal(rejected.code, "false_comparison");
    }
    const mixed = verifyComparison({
      evidenceId,
      summary: mixedCurrencySummary(),
      comparison: {
        left: fact(mixedCurrencySummary(), { metricId: "spend", dimension: "file", dimensionValue: "", unit: "USD" }),
        right: fact(mixedCurrencySummary(), { metricId: "spend", dimension: "file", dimensionValue: "", unit: "EUR" }),
        relation: "gt",
      },
    });
    assert.equal(mixed.status, "rejected");
    if (mixed.status === "rejected") {
      assert.equal(mixed.code, "incompatible_currency");
    }
  });

  it("explains a missing source and a zero denominator without using zero as the value", () => {
    const summary = zeroSummary();
    const missing = resolveFact({
      evidenceId,
      summary,
      reference: fact(summary, { metricId: "cost_per_conversion", dimension: "channel", dimensionValue: "Search", unit: "USD" }),
    });
    assert.equal(missing.status, "unavailable");
    if (missing.status === "unavailable") {
      assert.equal(missing.code, "missing_source");
      assert.equal(missing.message.includes("0"), false);
    }
    const zero = resolveFact({
      evidenceId,
      summary,
      reference: fact(summary, { metricId: "cpc", dimension: "channel", dimensionValue: "Search", unit: "USD" }),
    });
    assert.equal(zero.status, "unavailable");
    if (zero.status === "unavailable") {
      assert.equal(zero.code, "zero_denominator");
      assert.equal(zero.message, "Omitted because the denominator is zero.");
    }
  });

  it("refuses a cause, a recommendation, and an external benchmark", () => {
    const summary = channelSummary();
    assert.equal(classifyQuestion("Why did Meta cause more conversions?")?.code, "causal_claim");
    assert.equal(classifyQuestion("Which metrics are unavailable and why?"), null);
    assert.equal(renderMiaAnswer({ evidenceId, summary, question: "Recommend a budget increase" }).status, "refused");
    assert.equal(
      renderMiaAnswer({ evidenceId, summary, question: "How does this compare with the industry benchmark?" }).refusals[0]?.code,
      "external_benchmark",
    );
    const planted = renderMiaAnswer({
      evidenceId,
      summary,
      response: { recommendation: "Move budget to Meta", facts: [fact(summary, { metricId: "clicks", dimension: "channel", dimensionValue: "Meta", unit: "count" })] },
    });
    assert.equal(planted.status, "refused");
    assert.equal(planted.sentences.length, 0);
  });

  it("builds a packet from the saved summary and leaves source text out", () => {
    const summary = { ...channelSummary(), sourceText: "date,campaign,SECRET-CSV" } as EvidenceSummary;
    const packet = buildEvidencePacket(evidenceId, summary);
    const meta = packet.available.find(
      (item) => item.status === "available" && item.reference.dimensionValue === "Meta" && item.reference.metricId === "revenue_per_spend",
    );
    assert.equal(meta?.status, "available");
    if (meta?.status === "available") {
      assert.equal(meta.display, "6.80x");
    }
    assert.equal(JSON.stringify(packet).includes("SECRET-CSV"), false);
    assert.equal(JSON.stringify(packet).includes("sourceText"), false);
    assert.deepEqual(packet.currencyCodes, ["USD"]);
  });
});

describe("mia evidence access", () => {
  it("reads evidence only for the authenticated session user", async () => {
    const calls: { ownerId: string; evidenceId: string }[] = [];
    replaceEvidenceActionDependencies({
      session: async () => ({
        userId,
        email: "owner@example.com",
        emailConfirmed: true,
        assurance: "aal2",
        verifiedTotp: true,
      }),
      evidence: {
        async readEvidence(ownerId, requestedId) {
          calls.push({ ownerId, evidenceId: requestedId });
          return {
            id: requestedId,
            createdAt: "2024-03-01T00:00:00.000Z",
            parserVersion: PARSER_VERSION,
            calculationVersion: CALCULATION_VERSION,
            summary: channelSummary(),
          };
        },
      },
    });
    const result = await readMiaEvidence(evidenceId);
    assert.equal(result.ok, true);
    assert.deepEqual(calls, [{ ownerId: userId, evidenceId }]);
    assert.equal(JSON.stringify(result).includes("sourceText"), false);
    const source = fs.readFileSync(path.join(miaRoot, "access.ts"), "utf8");
    assert.match(source, /import "server-only"/);
    assert.match(source, /currentSession\(\)/);
    assert.match(source, /snapshot\.userId/);
    assert.equal(source.includes("sourceText"), false);
    assert.equal(source.includes("source_text"), false);
  });
});

function code(result: ReturnType<typeof resolveFact>): string {
  return result.status === "unavailable" ? result.code : result.status;
}

function fact(
  summary: EvidenceSummary,
  input: Pick<FactReference, "metricId" | "dimension" | "dimensionValue" | "unit">,
): FactReference {
  return { ...input, period: summary.period, evidenceId };
}

function channelSummary(): EvidenceSummary {
  const parsed = parseCampaignCsv(
    new TextEncoder().encode(
      [
        "date,campaign,channel,spend,impressions,clicks,conversions,revenue,currency",
        "2024-02-01,Spring,Google,32.50,1000,250,13,162.50,USD",
        "2024-02-01,Spring,Meta,22.00,900,300,15,149.50,USD",
        "",
      ].join("\n"),
    ),
  );
  if (!parsed.ok) {
    throw new Error(parsed.code);
  }
  return calculateEvidence(parsed);
}

function mixedCurrencySummary(): EvidenceSummary {
  return {
    calculationVersion: CALCULATION_VERSION,
    parserVersion: PARSER_VERSION,
    currencySource: "column",
    period,
    impressions: "20",
    clicks: "4",
    ctr: { kind: "exact", value: "0.2" },
    currencies: [
      { currency: "EUR", spend: "2.00", cpc: { kind: "exact", value: "2" } },
      { currency: "USD", spend: "10.00", cpc: { kind: "exact", value: "3.333333" } },
    ],
    channels: [],
    campaigns: [],
  };
}

function zeroSummary(): EvidenceSummary {
  return {
    calculationVersion: CALCULATION_VERSION,
    parserVersion: PARSER_VERSION,
    currencySource: "upload",
    period,
    impressions: "0",
    clicks: "0",
    ctr: { kind: "omitted", reason: "zero_denominator" },
    currencies: [
      {
        currency: "USD",
        spend: "0.00",
        revenue: "5.00",
        cpc: { kind: "omitted", reason: "zero_denominator" },
        revenuePerSpend: { kind: "omitted", reason: "zero_denominator" },
      },
    ],
    channels: [
      {
        name: "Search",
        impressions: "0",
        clicks: "0",
        ctr: { kind: "omitted", reason: "zero_denominator" },
        currencies: [
          {
            currency: "USD",
            spend: "0.00",
            revenue: "5.00",
            cpc: { kind: "omitted", reason: "zero_denominator" },
            revenuePerSpend: { kind: "omitted", reason: "zero_denominator" },
          },
        ],
      },
    ],
    campaigns: [],
  };
}
