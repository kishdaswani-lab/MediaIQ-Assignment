import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { calculateEvidence } from "./calculate-evidence.ts";
import { addDecimals, formatDecimal, parseMoney } from "./decimal.ts";
import { parseCampaignCsv } from "./parse-campaign-csv.ts";
import { MAX_CSV_BYTES, MAX_DATA_ROWS, type ParsedEvidence } from "./types.ts";

const encoder = new TextEncoder();
const HEADER = "date,campaign,channel,spend,impressions,clicks";

function bytes(text: string): Uint8Array {
  return encoder.encode(text);
}

function file(body: string, header = HEADER): Uint8Array {
  return bytes(`${header}\n${body}`);
}

function parseOk(body: string, currency = "USD", header = HEADER): ParsedEvidence {
  const result = parseCampaignCsv(file(body, header), { currency });
  assert.equal(result.ok, true);
  if (!result.ok) {
    throw new Error(result.code);
  }
  return result;
}

function codeOf(result: ReturnType<typeof parseCampaignCsv>): string {
  return result.ok ? "ok" : result.code;
}

describe("decimal sums", () => {
  it("adds 10.10 and 0.20 as 10.30", () => {
    const left = parseMoney("10.10");
    const right = parseMoney("0.20");
    assert.ok(left);
    assert.ok(right);
    assert.equal(formatDecimal(addDecimals(left, right)), "10.30");
  });

  it("adds 0.10 and 0.20 as 0.30", () => {
    const left = parseMoney("0.10");
    const right = parseMoney("0.20");
    assert.ok(left);
    assert.ok(right);
    assert.equal(formatDecimal(addDecimals(left, right)), "0.30");
  });

  it("adds 10 and 0.20 as 10.20", () => {
    const left = parseMoney("10");
    const right = parseMoney("0.20");
    assert.ok(left);
    assert.ok(right);
    assert.equal(formatDecimal(addDecimals(left, right)), "10.20");
  });
});

describe("campaign csv parser", () => {
  it("accepts several campaigns and channels", () => {
    const parsed = parseOk(
      [
        "2024-02-29,Spring,Search,10.10,100,40",
        "2024-03-01,Spring,Social,0.20,50,10",
        "2024-03-02,Fall,Search,5,25,5",
      ].join("\n"),
    );
    assert.equal(parsed.rows.length, 3);
    assert.equal(parsed.currencySource, "upload");
    assert.equal(parsed.rows[0].campaign, "Spring");
    assert.equal(parsed.rows[1].channel, "Social");
    assert.deepEqual(
      parsed.rows.map((row) => row.currency),
      ["USD", "USD", "USD"],
    );
  });

  it("keeps campaign and channel text case-sensitive", () => {
    const parsed = parseOk("2024-01-01,Spring,Search,1,1,1\n2024-01-01,spring,search,1,1,1");
    assert.deepEqual(
      parsed.rows.map((row) => [row.campaign, row.channel]),
      [
        ["Spring", "Search"],
        ["spring", "search"],
      ],
    );
  });

  it("accepts a quoted comma", () => {
    const parsed = parseOk('2024-01-01,"North, East",Search,1,10,2');
    assert.equal(parsed.rows[0].campaign, "North, East");
  });

  it("accepts a quoted line break", () => {
    const parsed = parseOk('2024-01-01,"North\nEast",Search,1,10,2');
    assert.equal(parsed.rows[0].campaign, "North\nEast");
  });

  it("accepts an escaped quote", () => {
    const parsed = parseOk('2024-01-01,"Say ""Hi""",Search,1,10,2');
    assert.equal(parsed.rows[0].campaign, 'Say "Hi"');
  });

  it("accepts a leading UTF-8 BOM", () => {
    const body = bytes(`${HEADER}\n2024-01-01,Spring,Search,1,10,2`);
    const withBom = new Uint8Array(body.length + 3);
    withBom.set([0xef, 0xbb, 0xbf], 0);
    withBom.set(body, 3);
    const parsed = parseCampaignCsv(withBom, { currency: "USD" });
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.rows[0].campaign, "Spring");
    }
  });

  it("accepts a leap day and rejects impossible dates", () => {
    assert.equal(parseCampaignCsv(file("2024-02-29,Spring,Search,1,1,1"), { currency: "USD" }).ok, true);
    assert.equal(codeOf(parseCampaignCsv(file("2026-02-31,Spring,Search,1,1,1"), { currency: "USD" })), "invalid_date");
    assert.equal(codeOf(parseCampaignCsv(file("2026-13-01,Spring,Search,1,1,1"), { currency: "USD" })), "invalid_date");
    assert.equal(codeOf(parseCampaignCsv(file("2025-02-29,Spring,Search,1,1,1"), { currency: "USD" })), "invalid_date");
    assert.equal(codeOf(parseCampaignCsv(file("01/02/2024,Spring,Search,1,1,1"), { currency: "USD" })), "invalid_date");
  });

  it("reads currency from the column and does not replace it with the upload selection", () => {
    const header = `${HEADER},currency`;
    const parsed = parseCampaignCsv(file("2024-01-01,Spring,Search,1,10,2,USD", header), {
      currency: "EUR",
    });
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.currencySource, "column");
      assert.equal(parsed.rows[0].currency, "USD");
    }
  });

  it("applies an upload currency only when the column is absent", () => {
    const parsed = parseOk("2024-01-01,Spring,Search,1,10,2", "EUR");
    assert.equal(parsed.currencySource, "upload");
    assert.equal(parsed.rows[0].currency, "EUR");
  });

  it("trims and matches headers without regard to case", () => {
    const parsed = parseCampaignCsv(
      file("2024-01-01,Spring,Search,1,10,2", " Date,CAMPAIGN, Channel ,Spend,Impressions,Clicks"),
      { currency: "USD" },
    );
    assert.equal(parsed.ok, true);
  });

  it("rejects invalid UTF-8", () => {
    assert.equal(codeOf(parseCampaignCsv(Uint8Array.of(0xff))), "invalid_utf8");
    assert.equal(codeOf(parseCampaignCsv(Uint8Array.of(0xff, 0xfe, 0x61, 0x00))), "invalid_utf8");
  });

  it("rejects unknown, duplicate, and missing headers", () => {
    assert.equal(
      codeOf(parseCampaignCsv(file("2024-01-01,Spring,Search,1,1,1", `${HEADER},notes`), { currency: "USD" })),
      "unknown_header",
    );
    assert.equal(
      codeOf(parseCampaignCsv(file("2024-01-01,Spring,Search,1,1,1,1", `${HEADER},Spend`), { currency: "USD" })),
      "duplicate_header",
    );
    assert.equal(
      codeOf(parseCampaignCsv(bytes("date,campaign,channel,spend,impressions\n2024-01-01,Spring,Search,1,1"), { currency: "USD" })),
      "missing_required_header",
    );
  });

  it("rejects missing required and optional values", () => {
    assert.equal(codeOf(parseCampaignCsv(file("2024-01-01,,Search,1,1,1"), { currency: "USD" })), "missing_value");
    assert.equal(
      codeOf(parseCampaignCsv(file("2024-01-01,Spring,Search,1,1,1,", `${HEADER},conversions`), { currency: "USD" })),
      "missing_value",
    );
  });

  it("rejects a blank revenue cell", () => {
    const result = parseCampaignCsv(file("2024-01-01,Spring,Search,1,1,1,", `${HEADER},revenue`), {
      currency: "USD",
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "missing_value");
      assert.equal(result.field, "revenue");
    }
    assert.equal("rows" in result, false);
  });

  it("accepts CRLF row endings", () => {
    const parsed = parseCampaignCsv(
      bytes(`${HEADER}\r\n2024-01-01,Spring,Search,1,10,2\r\n2024-01-02,Fall,Social,2,3,1\r\n`),
      { currency: "USD" },
    );
    assert.equal(parsed.ok, true);
    if (parsed.ok) {
      assert.equal(parsed.rows.length, 2);
      assert.equal(parsed.rows[0].campaign, "Spring");
      assert.equal(parsed.rows[1].channel, "Social");
    }
  });

  it("rejects a closing quote followed by stray characters", () => {
    const result = parseCampaignCsv(
      file('2024-01-01,"Spring"x,Search,1,1,1\n2024-01-02,Fall,Social,2,3,1'),
      { currency: "USD" },
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.code, "malformed_quote");
    }
    assert.equal("rows" in result, false);
  });

  it("rejects decimal and negative counts", () => {
    assert.equal(codeOf(parseCampaignCsv(file("2024-01-01,Spring,Search,1,1.5,1"), { currency: "USD" })), "invalid_count");
    assert.equal(codeOf(parseCampaignCsv(file("2024-01-01,Spring,Search,1,-1,1"), { currency: "USD" })), "invalid_count");
  });

  it("rejects invalid money and currency codes", () => {
    assert.equal(codeOf(parseCampaignCsv(file("2024-01-01,Spring,Search,-1,1,1"), { currency: "USD" })), "invalid_money");
    assert.equal(codeOf(parseCampaignCsv(file("2024-01-01,Spring,Search,$1,1,1"), { currency: "USD" })), "invalid_money");
    assert.equal(codeOf(parseCampaignCsv(file("2024-01-01,Spring,Search,\"1,000\",1,1"), { currency: "USD" })), "invalid_money");
    assert.equal(
      codeOf(parseCampaignCsv(file("2024-01-01,Spring,Search,1,1,1,usd", `${HEADER},currency`))),
      "invalid_currency",
    );
    assert.equal(
      codeOf(parseCampaignCsv(file("2024-01-01,Spring,Search,1,1,1,", `${HEADER},currency`))),
      "missing_value",
    );
    assert.equal(codeOf(parseCampaignCsv(file("2024-01-01,Spring,Search,1,1,1"), { currency: "usd" })), "invalid_currency");
    assert.equal(codeOf(parseCampaignCsv(file("2024-01-01,Spring,Search,1,1,1"))), "currency_required");
  });

  it("rejects unclosed quotes and the wrong field count", () => {
    assert.equal(codeOf(parseCampaignCsv(file('2024-01-01,"Spring,Search,1,1,1'), { currency: "USD" })), "unclosed_quote");
    assert.equal(codeOf(parseCampaignCsv(file("2024-01-01,Spring,Search,1,1"), { currency: "USD" })), "field_count");
  });

  it("rejects a header-only file and a file with no usable rows", () => {
    assert.equal(codeOf(parseCampaignCsv(bytes(`${HEADER}\n`), { currency: "USD" })), "no_data_rows");
    assert.equal(codeOf(parseCampaignCsv(bytes(`${HEADER}\n,,,,,\n\n`), { currency: "USD" })), "no_data_rows");
  });

  it("rejects files over the provisional size and row limits", () => {
    const oversized = new Uint8Array(MAX_CSV_BYTES + 1);
    oversized.fill(97);
    assert.equal(codeOf(parseCampaignCsv(oversized, { currency: "USD" })), "file_too_large");

    const atLimit = new Uint8Array(MAX_CSV_BYTES);
    atLimit.fill(32);
    assert.notEqual(codeOf(parseCampaignCsv(atLimit, { currency: "USD" })), "file_too_large");

    const accepted = [HEADER];
    const rejected = [HEADER];
    for (let index = 0; index < MAX_DATA_ROWS; index += 1) {
      accepted.push("2024-01-01,Spring,Search,1,1,1");
    }
    rejected.push(...accepted.slice(1), "2024-01-01,Spring,Search,1,1,1");
    assert.equal(parseCampaignCsv(bytes(accepted.join("\n")), { currency: "USD" }).ok, true);
    assert.equal(codeOf(parseCampaignCsv(bytes(rejected.join("\n")), { currency: "USD" })), "too_many_rows");
  });
});

describe("validated source text", () => {
  it("returns the decoded source text after a valid file is accepted", () => {
    const text = `${HEADER}\n2024-01-01,Spring,Search,10.10,100,40\n`;
    const parsed = parseCampaignCsv(bytes(text), { currency: "USD" });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) {
      return;
    }
    assert.equal(parsed.sourceText, text);
    assert.equal(parsed.rows[0].campaign, "Spring");
  });

  it("returns the decoded text without a leading UTF-8 BOM", () => {
    const text = `${HEADER}\n2024-01-01,Spring,Search,1,10,2`;
    const body = bytes(text);
    const withBom = new Uint8Array(body.length + 3);
    withBom.set([0xef, 0xbb, 0xbf], 0);
    withBom.set(body, 3);
    const parsed = parseCampaignCsv(withBom, { currency: "USD" });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) {
      return;
    }
    assert.equal(parsed.sourceText, text);
    assert.equal(parsed.sourceText.charCodeAt(0), text.charCodeAt(0));
  });

  it("returns quoted fields and embedded newlines unchanged", () => {
    const text = `${HEADER}\n2024-01-01,"North, ""East""\nWest",Search,1,10,2\n`;
    const parsed = parseCampaignCsv(bytes(text), { currency: "USD" });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) {
      return;
    }
    assert.equal(parsed.sourceText, text);
    assert.equal(parsed.rows[0].campaign, 'North, "East"\nWest');
  });

  it("rejects invalid UTF-8 without source text", () => {
    const result = parseCampaignCsv(Uint8Array.of(0xff, 0xfe, 0x61, 0x00));
    assert.equal(result.ok, false);
    assert.equal("sourceText" in result, false);
  });

  it("returns no source text when a later row makes the file invalid", () => {
    const result = parseCampaignCsv(
      file("2024-01-01,Spring,Search,1,1,1\n2026-02-31,Spring,Search,1,1,1"),
      { currency: "USD" },
    );
    assert.equal(result.ok, false);
    if (result.ok) {
      return;
    }
    assert.equal(result.code, "invalid_date");
    assert.equal("sourceText" in result, false);
  });
});

describe("campaign evidence calculation", () => {
  it("sums integers, channels, campaigns, and the exact decimal total", () => {
    const parsed = parseOk(
      ["2024-02-01,Spring,Search,10.10,8,4", "2024-02-01,Spring,Search,0.20,2,1", "2024-03-01,Fall,Social,1,10,5"].join(
        "\n",
      ),
    );
    const summary = calculateEvidence(parsed);
    assert.equal(summary.impressions, "20");
    assert.equal(summary.clicks, "10");
    assert.equal(summary.period.start, "2024-02-01");
    assert.equal(summary.period.end, "2024-03-01");
    assert.equal(summary.currencies[0].spend, "11.30");
    assert.equal(summary.ctr.kind, "exact");
    if (summary.ctr.kind === "exact") {
      assert.equal(summary.ctr.value, "0.5");
    }
    const search = summary.channels.find((group) => group.name === "Search");
    const social = summary.channels.find((group) => group.name === "Social");
    assert.equal(search?.impressions, "10");
    assert.equal(search?.currencies[0].spend, "10.30");
    assert.equal(social?.impressions, "10");
    const spring = summary.campaigns.find((group) => group.name === "Spring");
    const fall = summary.campaigns.find((group) => group.name === "Fall");
    assert.equal(spring?.clicks, "5");
    assert.equal(spring?.currencies[0].spend, "10.30");
    assert.equal(fall?.impressions, "10");
  });

  it("keeps file counts exact across currencies", () => {
    const header = `${HEADER},currency`;
    const result = parseCampaignCsv(
      file(
        ["2024-01-01,Spring,Search,10.10,10,2,USD", "2024-01-02,Spring,Search,0.20,10,1,EUR"].join("\n"),
        header,
      ),
    );
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    const summary = calculateEvidence(result);
    assert.equal(summary.impressions, "20");
    assert.equal(summary.clicks, "3");
    assert.equal(summary.channels[0].impressions, "20");
    assert.equal(summary.channels[0].clicks, "3");
    assert.deepEqual(
      summary.currencies.map((entry) => entry.spend),
      ["0.20", "10.10"],
    );
  });

  it("keeps Spring and spring as distinct campaigns", () => {
    const parsed = parseOk(
      ["2024-01-01,Spring,Search,10,10,2", "2024-01-01,spring,Search,0.20,5,1"].join("\n"),
    );
    const summary = calculateEvidence(parsed);
    assert.deepEqual(
      summary.campaigns.map((group) => [group.name, group.impressions, group.clicks, group.currencies[0].spend]),
      [
        ["Spring", "10", "2", "10"],
        ["spring", "5", "1", "0.20"],
      ],
    );
    assert.equal(summary.impressions, "15");
    assert.equal(summary.clicks, "3");
  });

  it("sums unequal spend scales through the file total", () => {
    const parsed = parseOk(["2024-01-01,Spring,Search,10,4,2", "2024-01-02,Spring,Social,0.20,6,1"].join("\n"));
    const summary = calculateEvidence(parsed);
    assert.equal(summary.currencies[0].spend, "10.20");
    assert.equal(summary.impressions, "10");
    assert.equal(summary.clicks, "3");
  });

  it("keeps each currency separate", () => {
    const header = `${HEADER},currency`;
    const result = parseCampaignCsv(
      file(["2024-01-01,Spring,Search,10.10,10,2,USD", "2024-01-02,Spring,Search,0.20,10,1,EUR"].join("\n"), header),
    );
    assert.equal(result.ok, true);
    if (!result.ok) {
      return;
    }
    const summary = calculateEvidence(result);
    assert.deepEqual(
      summary.currencies.map((entry) => [entry.currency, entry.spend]),
      [
        ["EUR", "0.20"],
        ["USD", "10.10"],
      ],
    );
    assert.equal("spend" in summary, false);
    assert.equal(summary.currencies[0].cpc.kind, "exact");
    assert.equal(summary.currencies[1].cpc.kind, "exact");
    if (summary.currencies[1].cpc.kind === "exact") {
      assert.equal(summary.currencies[1].cpc.value, "5.05");
    }
  });

  it("calculates exact rates and omits a zero denominator or an inexact rate", () => {
    const header = `${HEADER},conversions,revenue,currency`;
    const exact = parseCampaignCsv(
      file("2024-01-01,Spring,Search,10.10,10,2,2,20.20,USD", header),
    );
    assert.equal(exact.ok, true);
    if (exact.ok) {
      const summary = calculateEvidence(exact);
      assert.equal(summary.conversions, "2");
      assert.equal(summary.currencies[0].revenue, "20.20");
      assert.deepEqual(summary.ctr, { kind: "exact", value: "0.2" });
      assert.deepEqual(summary.currencies[0].cpc, { kind: "exact", value: "5.05" });
      assert.deepEqual(summary.currencies[0].costPerConversion, { kind: "exact", value: "5.05" });
      assert.deepEqual(summary.currencies[0].revenuePerSpend, { kind: "exact", value: "2" });
    }

    const zero = parseCampaignCsv(
      file("2024-01-01,Spring,Search,0.00,0,0,0,5.00,USD", header),
    );
    assert.equal(zero.ok, true);
    if (zero.ok) {
      const summary = calculateEvidence(zero);
      assert.deepEqual(summary.ctr, { kind: "omitted", reason: "zero_denominator" });
      assert.deepEqual(summary.currencies[0].cpc, { kind: "omitted", reason: "zero_denominator" });
      assert.deepEqual(summary.currencies[0].costPerConversion, {
        kind: "omitted",
        reason: "zero_denominator",
      });
      assert.deepEqual(summary.currencies[0].revenuePerSpend, {
        kind: "omitted",
        reason: "zero_denominator",
      });
      assert.equal(summary.currencies[0].spend, "0.00");
    }

    const inexact = parseCampaignCsv(
      file("2024-01-01,Spring,Search,10.10,9,3,3,1,USD", header),
    );
    assert.equal(inexact.ok, true);
    if (inexact.ok) {
      const summary = calculateEvidence(inexact);
      assert.deepEqual(summary.ctr, { kind: "omitted", reason: "not_exact" });
      assert.deepEqual(summary.currencies[0].cpc, { kind: "omitted", reason: "not_exact" });
      assert.deepEqual(summary.currencies[0].costPerConversion, { kind: "omitted", reason: "not_exact" });
      assert.deepEqual(summary.currencies[0].revenuePerSpend, { kind: "omitted", reason: "not_exact" });
    }
  });
});
