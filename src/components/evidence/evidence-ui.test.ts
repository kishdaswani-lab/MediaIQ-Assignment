import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { calculateEvidence } from "../../server/evidence/calculate-evidence";
import { parseCampaignCsv } from "../../server/evidence/parse-campaign-csv";
import { MAX_CSV_BYTES, type EvidenceSummary } from "../../server/evidence/types";
import {
  buildUploadFormData,
  countLabel,
  currencyLabel,
  formatCount,
  formatCurrencyAmount,
  formatCurrencyRate,
  formatPercentage,
  formatRoas,
  deleteEvidenceConfirmation,
  deleteRequest,
  detailState,
  inspectUploadFile,
  libraryHrefAfterDelete,
  listInputFromQuery,
  nextLibraryHref,
  rateText,
  submitUpload,
  summaryViewModel,
  uploadIsUnconfirmed,
  type EvidenceListRecord,
} from "./contracts";

const evidenceId = "11111111-1111-4111-8111-111111111111";
const evidenceRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(evidenceRoot, "../../..");

describe("evidence upload workflow", () => {
  it("accepts a csv selection and rejects a file over 1 MiB before any action", async () => {
    const selected = inspectUploadFile({ name: "spring.csv", size: 128 });
    assert.deepEqual(selected, { ok: true });

    const oversized = inspectUploadFile({ name: "spring.csv", size: MAX_CSV_BYTES + 1 });
    assert.equal(oversized.ok, false);
    if (!oversized.ok) {
      assert.equal(oversized.message, "The file is larger than 1 MiB.");
    }

    let calls = 0;
    const outcome = await submitUpload(
      { file: fileOf("spring.csv", MAX_CSV_BYTES + 1), currency: "USD", currencyRequired: false },
      async () => {
        calls += 1;
        return { ok: true };
      },
    );
    assert.equal(outcome.status, "client");
    assert.equal(calls, 0);
  });

  it("asks for a currency when the server requires one and does not infer it", async () => {
    let calls = 0;
    const blocked = await submitUpload(
      { file: fileOf("plain.csv", 32), currency: "", currencyRequired: true },
      async () => {
        calls += 1;
        return { ok: false };
      },
    );
    assert.equal(blocked.status, "client");
    assert.equal(calls, 0);

    const sent = await submitUpload(
      { file: fileOf("plain.csv", 32), currency: "usd", currencyRequired: true },
      async (formData) => {
        calls += 1;
        assert.equal(formData.get("currency"), "USD");
        return { ok: false, code: "currency_required", message: "Select one three-letter currency when the file has no currency column." };
      },
    );
    assert.equal(sent.status, "server");
    assert.equal(calls, 1);
  });

  it("sends a selected currency without letting that selection replace a currency column", async () => {
    const formData = buildUploadFormData(fileOf("campaign.csv", 40), "gbp");
    assert.equal(formData.get("currency"), "GBP");
    const model = summaryViewModel(summary());
    assert.equal(model.currencySource, "column");
    assert.deepEqual(model.currencies.map((item) => item.currency), ["USD", "EUR"]);
    assert.equal(model.currencies.some((item) => item.currency === "GBP"), false);
    assert.equal(Object.hasOwn(model, "combinedSpend"), false);
  });

  it("returns one server result for success, validation failure, and an unconfirmed upload", async () => {
    const saved = await submitUpload(
      { file: fileOf("campaign.csv", 40), currency: "", currencyRequired: false },
      async () => ({ ok: true, evidence: { id: evidenceId, summary: summary() } }),
    );
    assert.equal(saved.status, "server");
    if (saved.status === "server") {
      assert.equal(saved.result.ok, true);
    }

    const rejected = await submitUpload(
      { file: fileOf("campaign.csv", 40), currency: "", currencyRequired: false },
      async () => ({ ok: false, kind: "validation", message: "A date is not a real calendar date in YYYY-MM-DD form." }),
    );
    assert.equal(rejected.status, "server");
    if (rejected.status === "server" && !rejected.result.ok) {
      assert.equal(rejected.result.kind, "validation");
    }

    let calls = 0;
    const unconfirmed = await submitUpload(
      { file: fileOf("campaign.csv", 40), currency: "USD", currencyRequired: false },
      async () => {
        calls += 1;
        return {
          ok: false,
          kind: "unconfirmed",
          message: "The evidence could not be confirmed. Refresh the list before submitting the file again.",
        };
      },
    );
    assert.equal(calls, 1);
    assert.equal(unconfirmed.status, "server");
    if (unconfirmed.status === "server") {
      assert.equal(uploadIsUnconfirmed(unconfirmed.result), true);
      assert.equal(unconfirmed.result.ok, false);
    }
    assert.equal(fs.readFileSync(path.join(evidenceRoot, "upload-form.tsx"), "utf8").includes("useEffect"), false);
  });
});

describe("evidence library and detail", () => {
  it("describes an empty library, a page of records, and the next cursor", () => {
    const records = Array.from({ length: 20 }, (_, index) => record(index));
    const next = nextLibraryHref(records);
    assert.equal(next?.startsWith("/performance?"), true);
    assert.equal(next?.includes(records[19].id), true);
    assert.equal(next?.includes("owner"), false);
    assert.equal(nextLibraryHref(records.slice(0, 19)), null);
    assert.equal(countLabel(null), "Not available");
    assert.equal(countLabel(0), "0");
    assert.equal(countLabel(2700), "2,700");
    assert.equal(formatCount("2700"), "2,700");
    assert.equal(currencyLabel([]), "Not available");
    assert.deepEqual(listInputFromQuery({}), undefined);
    assert.deepEqual(listInputFromQuery({ before: "2024-04-01T00:00:00.000Z", beforeId: evidenceId }), {
      limit: 20,
      cursor: { beforeCreatedAt: "2024-04-01T00:00:00.000Z", beforeId: evidenceId },
    });
  });

  it("renders stored figures without recalculating or filling missing rates with zero", () => {
    const model = summaryViewModel(summary());
    assert.equal(model.impressions, "13");
    assert.equal(model.clicks, "4");
    assert.equal(model.conversions, null);
    assert.equal(model.ctr, "Omitted because the rate is not an exact decimal.");
    assert.equal(model.ctr.includes("0"), false);
    assert.equal(model.currencies[0].spend, "$10.10 USD");
    assert.equal(model.currencies[1].spend, "€2.00 EUR");
    assert.equal(model.currencies[0].revenue, null);
    assert.equal(model.currencies[1].cpc, "€2.00 EUR");
    assert.equal(model.currencies[0].currency, "USD");
    assert.equal(model.currencies[1].currency, "EUR");
    assert.equal(rateText({ kind: "omitted", reason: "zero_denominator" }).includes("0"), false);
    assert.equal(model.channels[0].name, "Search");
    assert.equal(model.channels[0].currencies[0].spend, "$10.10 USD");
    assert.equal(model.channels[0].ctr, "33.33%");
    assert.equal(model.channels[0].ctrOmitted, false);
    const source = fs.readFileSync(path.join(evidenceRoot, "summary-view.tsx"), "utf8");
    assert.equal(source.includes("parseFloat"), false);
    assert.equal(source.includes("Number("), false);
  });

  it("uses the same not-found presentation for a missing record and another account's record", () => {
    const missing = detailState({ ok: false, kind: "not_found", message: "The evidence was not found." });
    const foreign = detailState({ ok: false, kind: "not_found", message: "The evidence was not found." });
    assert.deepEqual(missing, foreign);
    assert.equal(missing.status, "missing");
  });
});

describe("evidence deletion", () => {
  it("sends the approved confirmation and skips the action when cancelled", async () => {
    assert.equal(deleteEvidenceConfirmation, "Delete this evidence permanently? This cannot be undone.");
    assert.equal(deleteRequest(evidenceId, false), null);
    let calls = 0;
    const request = deleteRequest(evidenceId, false);
    if (request) {
      calls += 1;
    }
    assert.equal(calls, 0);

    const confirmed = deleteRequest(evidenceId, true);
    assert.deepEqual(confirmed, { evidenceId, confirmation: deleteEvidenceConfirmation });
    assert.equal(libraryHrefAfterDelete({ ok: false }), null);
    assert.equal(libraryHrefAfterDelete({ ok: true }), "/performance?deleted=1");
  });
});

describe("evidence display formatting", () => {
  it("rounds calculated rates to two decimal places and keeps omissions", () => {
    assert.equal(formatPercentage("0.1"), "10.00%");
    assert.equal(formatPercentage("0.125"), "12.50%");
    assert.equal(formatPercentage("0.333333"), "33.33%");
    assert.equal(formatPercentage("0.00004"), "0.00%");
    assert.equal(formatCurrencyAmount("USD", "25.30"), "$25.30 USD");
    assert.equal(formatCurrencyAmount("USD", "145"), "$145.00 USD");
    assert.equal(formatCurrencyAmount("USD", "10.125"), "$10.13 USD");
    assert.equal(formatCurrencyAmount("PHP", "1250"), "₱1,250.00 PHP");
    assert.equal(formatCurrencyAmount("EUR", "2"), "€2.00 EUR");
    assert.equal(formatCurrencyAmount("GBP", "1.474"), "£1.47 GBP");
    assert.equal(formatCurrencyRate("USD", "0.074"), "$0.07 USD");
    assert.equal(formatCurrencyRate("USD", "1.466"), "$1.47 USD");
    assert.equal(formatCurrencyRate("USD", "0.004"), "$0.00 USD");
    assert.equal(formatCurrencyRate("USD", "0.005"), "$0.01 USD");
    assert.equal(formatRoas("5"), "5.00x");
    assert.equal(formatRoas("6.80"), "6.80x");
    assert.equal(formatRoas("6.796116"), "6.80x");
    assert.equal(formatRoas("0.004"), "0.00x");
    assert.equal(formatCount(2700), "2,700");

    const stored = summary();
    const before = JSON.stringify(stored);
    const model = summaryViewModel({
      ...stored,
      impressions: "2700",
      ctr: { kind: "exact", value: "0.1" },
      currencies: [
        {
          currency: "USD",
          spend: "25.30",
          cpc: { kind: "exact", value: "0.074" },
          costPerConversion: { kind: "exact", value: "1.466" },
          revenuePerSpend: { kind: "exact", value: "6.796116" },
        },
        {
          currency: "PHP",
          spend: "1250",
          cpc: { kind: "omitted", reason: "not_exact" },
          revenuePerSpend: { kind: "omitted", reason: "zero_denominator" },
        },
        {
          currency: "EUR",
          spend: "2.00",
          revenue: "5.00",
          cpc: { kind: "exact", value: "2" },
        },
      ],
    });
    assert.equal(JSON.stringify(stored), before);
    assert.equal(stored.currencies[0].spend, "10.10");
    assert.equal(stored.currencies[1].spend, "2.00");
    assert.equal(model.impressions, "2,700");
    assert.equal(model.ctr, "10.00%");
    assert.equal(model.ctrOmitted, false);
    assert.equal(model.currencies[0].spend, "$25.30 USD");
    assert.equal(model.currencies[0].cpc, "$0.07 USD");
    assert.equal(model.currencies[0].costPerConversion, "$1.47 USD");
    assert.equal(model.currencies[0].revenuePerSpend, "6.80x");
    assert.equal(model.currencies[0].cpcOmitted, false);
    assert.equal(model.currencies[0].revenuePerSpendOmitted, false);
    assert.equal(model.currencies[1].spend, "₱1,250.00 PHP");
    assert.equal(model.currencies[1].cpc, "Omitted because counts are shared across currencies.");
    assert.equal(model.currencies[1].cpcOmitted, true);
    assert.equal(model.currencies[1].revenuePerSpend, "Omitted because the denominator is zero.");
    assert.equal(model.currencies[1].revenuePerSpendOmitted, true);
    assert.equal(model.currencies[2].cpc, "€2.00 EUR");
    assert.equal(model.currencies[2].revenuePerSpend, "2.50x");
    assert.equal(model.currencies[2].revenuePerSpendOmitted, false);
    assert.equal(model.currencies.map((item) => item.currency).join(","), "USD,PHP,EUR");
    assert.equal(model.campaigns[0].ctr, "Omitted because the denominator is zero.");
    assert.equal(model.campaigns[0].ctrOmitted, true);
  });
});

describe("evidence display formatting", () => {
  it("derives repeating channel rates from stored operands", () => {
    const header = "date,campaign,channel,spend,impressions,clicks,conversions,revenue,currency";
    const body = [
      "2024-02-01,Spring,Google,32.50,1000,250,13,162.50,USD",
      "2024-02-01,Spring,Meta,22.00,900,300,15,149.50,USD",
    ].join("\n");
    const parsed = parseCampaignCsv(new TextEncoder().encode(`${header}\n${body}\n`));
    assert.equal(parsed.ok, true);
    if (!parsed.ok) {
      return;
    }
    const summary = calculateEvidence(parsed);
    const stored = JSON.stringify(summary);
    const meta = summary.channels.find((group) => group.name === "Meta");
    assert.equal(meta?.currencies[0].cpc.kind, "omitted");
    assert.equal(meta?.currencies[0].costPerConversion?.kind, "omitted");
    assert.equal(meta?.currencies[0].revenuePerSpend?.kind, "omitted");
    const model = summaryViewModel(summary);
    assert.equal(JSON.stringify(summary), stored);

    const google = model.channels.find((group) => group.name === "Google")?.currencies[0];
    const metaView = model.channels.find((group) => group.name === "Meta")?.currencies[0];
    assert.equal(google?.cpc, "$0.13 USD");
    assert.equal(google?.costPerConversion, "$2.50 USD");
    assert.equal(google?.revenuePerSpend, "5.00x");
    assert.equal(metaView?.cpc, "$0.07 USD");
    assert.equal(metaView?.costPerConversion, "$1.47 USD");
    assert.equal(metaView?.revenuePerSpend, "6.80x");
    assert.equal(google?.cpcOmitted, false);
    assert.equal(metaView?.revenuePerSpendOmitted, false);
  });

  it("omits missing inputs, zero denominators, and shared multi-currency counts", () => {
    const header = "date,campaign,channel,spend,impressions,clicks,conversions,revenue,currency";
    const zero = parseCampaignCsv(
      new TextEncoder().encode(`${header}\n2024-01-01,Spring,Search,0.00,0,0,0,5.00,USD\n`),
    );
    assert.equal(zero.ok, true);
    if (zero.ok) {
      const model = summaryViewModel(calculateEvidence(zero));
      assert.equal(model.currencies[0].cpc, "Omitted because the denominator is zero.");
      assert.equal(model.currencies[0].costPerConversion, "Omitted because the denominator is zero.");
      assert.equal(model.currencies[0].revenuePerSpend, "Omitted because the denominator is zero.");
      assert.equal(model.channels[0].currencies[0].cpcOmitted, true);
    }

    const countsOnly = parseCampaignCsv(
      new TextEncoder().encode("date,campaign,channel,spend,impressions,clicks\n2024-01-01,Spring,Search,10.10,9,3\n"),
      { currency: "USD" },
    );
    assert.equal(countsOnly.ok, true);
    if (countsOnly.ok) {
      const summary = calculateEvidence(countsOnly);
      const model = summaryViewModel(summary);
      assert.equal(summary.currencies[0].cpc.kind, "omitted");
      assert.equal(model.currencies[0].cpc, "$3.37 USD");
      assert.equal(model.currencies[0].costPerConversion, null);
      assert.equal(model.currencies[0].revenuePerSpend, null);
      assert.equal(model.currencies[0].revenue, null);
    }

    const mixedHeader = "date,campaign,channel,spend,impressions,clicks,conversions,revenue,currency";
    const mixed = parseCampaignCsv(
      new TextEncoder().encode(
        [
          mixedHeader,
          "2024-01-01,Spring,Search,10.00,10,3,1,20.00,USD",
          "2024-01-02,Spring,Search,2.00,10,1,1,4.00,EUR",
          "",
        ].join("\n"),
      ),
    );
    assert.equal(mixed.ok, true);
    if (mixed.ok) {
      const summary = calculateEvidence(mixed);
      const before = JSON.stringify(summary);
      const model = summaryViewModel(summary);
      assert.equal(JSON.stringify(summary), before);
      const channel = model.channels[0].currencies;
      assert.deepEqual(
        channel.map((money) => money.currency),
        ["EUR", "USD"],
      );
      assert.equal(channel[0].cpc, "€2.00 EUR");
      assert.equal(channel[0].revenuePerSpend, "2.00x");
      assert.equal(channel[1].cpc, "Omitted because counts are shared across currencies.");
      assert.equal(channel[1].cpcOmitted, true);
      assert.equal(channel[1].revenuePerSpend, "2.00x");
      assert.equal(model.currencies[0].currency, "EUR");
      assert.equal(model.currencies[1].currency, "USD");
    }
  });
});

describe("evidence ui boundary", () => {
  it("keeps evidence reads on the server actions and out of the service and pool", () => {
    const files = [
      ...fs.readdirSync(evidenceRoot).filter((name) => name.endsWith(".tsx")),
      path.join(repoRoot, "src/app/(app)/upload/page.tsx"),
      path.join(repoRoot, "src/app/(app)/performance/page.tsx"),
      path.join(repoRoot, "src/app/(app)/evidence/[id]/page.tsx"),
    ];
    for (const name of files) {
      const file = name.includes("page.tsx") ? name : path.join(evidenceRoot, name);
      const source = fs.readFileSync(file, "utf8");
      assert.equal(source.includes("evidence/service"), false, file);
      assert.equal(source.includes("evidence/pool"), false, file);
      assert.equal(source.includes("evidenceSql"), false, file);
      assert.equal(source.includes("sourceText"), false, file);
      assert.equal(source.includes("ownerId"), false, file);
    }
    const performance = fs.readFileSync(path.join(repoRoot, "src/app/(app)/performance/page.tsx"), "utf8");
    const detail = fs.readFileSync(path.join(repoRoot, "src/app/(app)/evidence/[id]/page.tsx"), "utf8");
    const upload = fs.readFileSync(path.join(repoRoot, "src/app/(app)/upload/page.tsx"), "utf8");
    assert.equal(performance.includes("listEvidenceAction"), true);
    assert.equal(performance.includes("Loading evidence"), true);
    assert.equal(detail.includes("readEvidenceAction"), true);
    assert.equal(upload.includes("CampaignUploadForm"), true);
    const dependencies = fs.readFileSync(path.join(repoRoot, "src/server/evidence/action-dependencies.ts"), "utf8");
    assert.equal(dependencies.includes(deleteEvidenceConfirmation), true);
  });
});

function fileOf(name: string, size: number): File {
  return new File([new Uint8Array(size)], name, { type: "text/csv" });
}

function record(index: number): EvidenceListRecord {
  return {
    id: `11111111-1111-4111-8111-${String(index).padStart(12, "0")}`,
    createdAt: `2024-04-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
    parserVersion: "monday-csv-1",
    calculationVersion: "campaign-descriptive-1",
    periodStart: "2024-02-01",
    periodEnd: "2024-02-02",
    campaignCount: index === 0 ? null : 2,
    channelCount: 2,
    currencyCodes: ["USD", "EUR"],
  };
}

function summary(): EvidenceSummary {
  return {
    calculationVersion: "campaign-descriptive-1",
    parserVersion: "monday-csv-1",
    currencySource: "column",
    period: { start: "2024-02-01", end: "2024-02-02" },
    impressions: "13",
    clicks: "4",
    ctr: { kind: "omitted", reason: "not_exact" },
    currencies: [
      { currency: "USD", spend: "10.10", cpc: { kind: "omitted", reason: "not_exact" } },
      {
        currency: "EUR",
        spend: "2.00",
        revenue: "5.00",
        cpc: { kind: "exact", value: "2" },
        revenuePerSpend: { kind: "omitted", reason: "zero_denominator" },
      },
    ],
    channels: [
      {
        name: "Search",
        impressions: "9",
        clicks: "3",
        ctr: { kind: "exact", value: "0.333333" },
        currencies: [{ currency: "USD", spend: "10.10", cpc: { kind: "omitted", reason: "not_exact" } }],
      },
    ],
    campaigns: [
      {
        name: "Spring",
        impressions: "9",
        clicks: "3",
        ctr: { kind: "omitted", reason: "zero_denominator" },
        currencies: [{ currency: "USD", spend: "10.10", cpc: { kind: "omitted", reason: "not_exact" } }],
      },
    ],
  };
}
