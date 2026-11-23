import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  deleteEvidence,
  evidenceInvalidPageMessage,
  evidenceUnavailableMessage,
  evidenceUnconfirmedMessage,
  EvidenceServiceError,
  insertEvidence,
  listEvidence,
  readEvidence,
  replaceEvidenceDatabase,
} from "./service";
import { CALCULATION_VERSION, PARSER_VERSION, type EvidenceSummary } from "./types";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const serviceSource = fs.readFileSync(new URL("./service.ts", import.meta.url), "utf8");
const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const evidenceId = "11111111-1111-4111-8111-111111111111";
const otherId = "22222222-2222-4222-8222-222222222222";
const sourceText = "date,campaign,channel,spend,impressions,clicks\n2024-02-01,Spring,Search,10.10,10,3";
const createdAt = new Date("2024-03-01T00:00:00.000Z");
const poison =
  "connect ECONNREFUSED postgres://evidence_writer:credential@database-host.example:5432/mediaiq role mediaiq_evidence_writer";

const summary: EvidenceSummary = {
  calculationVersion: CALCULATION_VERSION,
  parserVersion: PARSER_VERSION,
  currencySource: "column",
  period: { start: "2024-02-01", end: "2024-03-01" },
  impressions: "10",
  clicks: "3",
  ctr: { kind: "omitted", reason: "not_exact" },
  currencies: [
    {
      currency: "USD",
      spend: "10.10",
      cpc: { kind: "omitted", reason: "not_exact" },
    },
    {
      currency: "EUR",
      spend: "2.00",
      revenue: "5.00",
      cpc: { kind: "exact", value: "1.00" },
      revenuePerSpend: { kind: "exact", value: "2.5" },
    },
  ],
  channels: [
    {
      name: "Search",
      impressions: "10",
      clicks: "3",
      ctr: { kind: "omitted", reason: "not_exact" },
      currencies: [],
    },
  ],
  campaigns: [
    {
      name: "Spring",
      impressions: "10",
      clicks: "3",
      ctr: { kind: "omitted", reason: "not_exact" },
      currencies: [],
    },
  ],
};

type Call = { text: string; values: unknown[] };
type Responder = (call: Call) => unknown;

const calls: Call[] = [];
const logs: string[] = [];
let respond: Responder = () => {
  throw new Error("unexpected query");
};
const originalConsole = {
  log: console.log,
  error: console.error,
  warn: console.warn,
  info: console.info,
};

installDatabase();

afterEach(() => {
  calls.length = 0;
  logs.length = 0;
  respond = () => {
    throw new Error("unexpected query");
  };
  installDatabase();
  restoreConsole();
});

describe("evidence service", () => {
  it("inserts through the approved function and returns the read-back detail", async () => {
    respond = (call) => {
      if (call.text.includes("insert_campaign_evidence")) {
        return [{ id: evidenceId }];
      }
      return [storedRow()];
    };

    const detail = await insertEvidence(ownerId, sourceText, summary);

    assert.equal(calls.length, 2);
    assert.match(calls[0].text, /private\.insert_campaign_evidence/);
    assert.deepEqual(calls[0].values, [
      ownerId,
      sourceText,
      { json: summary },
      PARSER_VERSION,
      CALCULATION_VERSION,
    ]);
    assert.match(calls[1].text, /private\.read_campaign_evidence/);
    assert.deepEqual(calls[1].values, [ownerId, evidenceId]);
    assert.equal(detail.id, evidenceId);
    assert.equal(detail.createdAt, createdAt.toISOString());
    assert.equal(detail.parserVersion, PARSER_VERSION);
    assert.equal(detail.calculationVersion, CALCULATION_VERSION);
    assert.equal(detail.summary.currencies[1].currency, "EUR");
    assert.equal("sourceText" in detail, false);
    assert.equal("ownerId" in detail, false);
    assert.equal(JSON.stringify(detail).includes("secret question"), false);
  });

  it("returns a safe error when insert is rejected and does not try again", async () => {
    captureConsole();
    respond = () => {
      throw Object.assign(new Error(poison), { code: "22023" });
    };

    const error = await catchError(() => insertEvidence(ownerId, sourceText, summary));

    assert.equal(calls.length, 1);
    assert.ok(error instanceof EvidenceServiceError);
    assert.equal(error.kind, "unavailable");
    assert.equal(error.message, evidenceUnavailableMessage);
    assertSafe(error);
    assert.deepEqual(logs, []);
  });

  it("reports an unconfirmed insert when the connection drops before an id returns", async () => {
    captureConsole();
    respond = () => {
      throw Object.assign(new Error(poison), { code: "CONNECTION_CLOSED" });
    };

    const error = await catchError(() => insertEvidence(ownerId, sourceText, summary));

    assert.equal(calls.length, 1);
    assert.ok(error instanceof EvidenceServiceError);
    assert.equal(error.kind, "unconfirmed");
    assert.equal(error.message, evidenceUnconfirmedMessage);
    assertSafe(error);
    assert.deepEqual(logs, []);
  });

  it("returns an unconfirmed result when read-back fails after insert and does not insert again", async () => {
    captureConsole();
    respond = (call) => {
      if (call.text.includes("insert_campaign_evidence")) {
        return [{ id: evidenceId }];
      }
      throw Object.assign(new Error(poison), { code: "08006" });
    };

    const error = await catchError(() => insertEvidence(ownerId, sourceText, summary));

    assert.equal(calls.filter((call) => call.text.includes("insert_campaign_evidence")).length, 1);
    assert.equal(calls.filter((call) => call.text.includes("read_campaign_evidence")).length, 1);
    assert.ok(error instanceof EvidenceServiceError);
    assert.equal(error.kind, "unconfirmed");
    assert.equal(error.message, evidenceUnconfirmedMessage);
    assertSafe(error);
    assert.deepEqual(logs, []);
  });

  it("reads an owned record without source text or exchange fields", async () => {
    respond = () => [storedRow()];

    const detail = await readEvidence(ownerId, evidenceId);

    assert.match(calls[0].text, /private\.read_campaign_evidence/);
    assert.equal(calls[0].text.includes("source_text"), false);
    assert.equal(calls[0].text.includes("owner_id"), false);
    assert.equal(calls[0].text.includes("latest_question"), false);
    assert.deepEqual(calls[0].values, [ownerId, evidenceId]);
    assert.equal(detail?.id, evidenceId);
    assert.equal(detail?.summary.currencies[0].currency, "USD");
    assert.equal(detail && "sourceText" in detail, false);
    assert.equal(JSON.stringify(detail).includes(sourceText), false);
  });

  it("returns null when the owned record is absent", async () => {
    respond = () => [];

    assert.equal(await readEvidence(ownerId, evidenceId), null);
  });

  it("lists metadata with the cursor and omits summary, source, exchange, and owner", async () => {
    respond = () => [
      {
        id: evidenceId,
        created_at: createdAt,
        parser_version: PARSER_VERSION,
        calculation_version: CALCULATION_VERSION,
        period_start: "2024-02-01",
        period_end: "2024-03-01",
        campaign_count: 2,
        channel_count: 3,
        currency_codes: ["USD", "EUR"],
        summary,
        source_text: sourceText,
        owner_id: ownerId,
        latest_question: "secret question",
      },
      {
        id: otherId,
        created_at: "2024-01-01T00:00:00.000Z",
        parser_version: PARSER_VERSION,
        calculation_version: CALCULATION_VERSION,
        period_start: null,
        period_end: null,
        campaign_count: null,
        channel_count: null,
        currency_codes: [],
      },
    ];

    const page = await listEvidence(ownerId, 20, {
      beforeCreatedAt: "2024-04-01T00:00:00.000Z",
      beforeId: evidenceId,
    });

    assert.match(calls[0].text, /private\.list_campaign_evidence/);
    assert.equal(calls[0].text.includes("summary"), false);
    assert.equal(calls[0].text.includes("source_text"), false);
    assert.equal(calls[0].text.includes("owner_id"), false);
    assert.equal(calls[0].text.includes("latest_"), false);
    assert.deepEqual(calls[0].values, [ownerId, 20, "2024-04-01T00:00:00.000Z", evidenceId]);
    assert.equal(page.length, 2);
    assert.deepEqual(page[0], {
      id: evidenceId,
      createdAt: createdAt.toISOString(),
      parserVersion: PARSER_VERSION,
      calculationVersion: CALCULATION_VERSION,
      periodStart: "2024-02-01",
      periodEnd: "2024-03-01",
      campaignCount: 2,
      channelCount: 3,
      currencyCodes: ["USD", "EUR"],
    });
    assert.equal(page[1].periodStart, null);
    assert.equal(page[1].campaignCount, null);
    assert.deepEqual(page[1].currencyCodes, []);
    assert.equal(JSON.stringify(page).includes(sourceText), false);
    assert.equal(JSON.stringify(page).includes("secret question"), false);
    assert.equal(JSON.stringify(page).includes(ownerId), false);
  });

  it("sends a null cursor and rejects a page that the database must not see", async () => {
    respond = () => [];

    assert.deepEqual(await listEvidence(ownerId, 1, null), []);
    assert.deepEqual(calls[0].values, [ownerId, 1, null, null]);

    calls.length = 0;
    const error = await catchError(() => listEvidence(ownerId, 51, null));
    assert.ok(error instanceof EvidenceServiceError);
    assert.equal(error.kind, "invalid");
    assert.equal(error.message, evidenceInvalidPageMessage);
    assert.equal(calls.length, 0);
  });

  it("returns true only when delete confirms the requested id", async () => {
    respond = () => [{ id: evidenceId }];
    assert.equal(await deleteEvidence(ownerId, evidenceId), true);
    assert.match(calls[0].text, /private\.delete_campaign_evidence/);
    assert.deepEqual(calls[0].values, [ownerId, evidenceId]);

    respond = () => [{ id: null }];
    assert.equal(await deleteEvidence(ownerId, evidenceId), false);

    respond = () => [{ id: otherId }];
    assert.equal(await deleteEvidence(ownerId, evidenceId), false);
  });

  it("hides a raw driver error from delete", async () => {
    captureConsole();
    respond = () => {
      throw Object.assign(new Error(poison), { code: "08006" });
    };

    const error = await catchError(() => deleteEvidence(ownerId, evidenceId));

    assert.ok(error instanceof EvidenceServiceError);
    assert.equal(error.kind, "unavailable");
    assert.equal(error.message, evidenceUnavailableMessage);
    assertSafe(error);
    assert.deepEqual(logs, []);
  });

  it("stays on the evidence functions and out of client, audit, and service-role paths", () => {
    assert.match(serviceSource, /import "server-only"/);
    assert.equal(serviceSource.includes("securitySql"), false);
    assert.equal(serviceSource.includes("MEDIAIQ_SECURITY_DATABASE_URL"), false);
    assert.equal(serviceSource.includes("SERVICE_ROLE"), false);
    assert.equal(serviceSource.includes("createClient"), false);
    assert.equal(serviceSource.includes("private.campaign_evidence"), false);
    assert.equal(serviceSource.includes("formData"), false);
    assert.equal(serviceSource.includes("searchParams"), false);
    assertNoClientImport();

    const child = spawnSync(
      process.execPath,
      [
        "--import",
        "./src/server/evidence/register-test-hook.mjs",
        "--experimental-strip-types",
        "--input-type=module",
        "--eval",
        "await import('./src/server/evidence/service.ts');",
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        env: { ...process.env, MEDIAIQ_REQUIRE_SERVER_ONLY: "1" },
      },
    );

    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /This module cannot be imported from a Client Component module/);
    assert.equal(child.stderr.includes("credential"), false);
    assert.equal(child.stderr.includes("database-host.example"), false);
  });

  it("does not open a database connection by importing the service", () => {
    const child = spawnSync(
      process.execPath,
      [
        "--conditions=react-server",
        "--import",
        "./src/server/evidence/register-test-hook.mjs",
        "--experimental-strip-types",
        "--input-type=module",
        "--eval",
        [
          "import net from 'node:net';",
          "let calls = 0;",
          "net.connect = () => { calls += 1; throw new Error('database connection attempted'); };",
          "await import('./src/server/evidence/service.ts');",
          "if (calls !== 0) throw new Error('database connection attempted');",
        ].join("\n"),
      ],
      { cwd: repoRoot, encoding: "utf8" },
    );

    assert.equal(child.status, 0, child.stderr);
  });
});

function storedRow() {
  return {
    id: evidenceId,
    created_at: createdAt,
    summary,
    parser_version: PARSER_VERSION,
    calculation_version: CALCULATION_VERSION,
    source_text: sourceText,
    owner_id: ownerId,
    latest_question: "secret question",
    latest_answer: "secret answer",
    latest_exchange_at: createdAt,
  };
}

function installDatabase(): void {
  replaceEvidenceDatabase(() => {
    const sql = Object.assign(
      async (strings: TemplateStringsArray, ...values: readonly unknown[]) => {
        const call = { text: strings.join(" "), values: [...values] };
        calls.push(call);
        return respond(call);
      },
      {
        json(value: unknown) {
          return { json: value };
        },
      },
    );
    return sql;
  });
}

async function catchError(fn: () => Promise<unknown>): Promise<Error> {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof Error);
    return error;
  }
  assert.fail("expected an error");
}

function assertSafe(error: Error): void {
  assert.equal(error.message.includes("credential"), false);
  assert.equal(error.message.includes("database-host.example"), false);
  assert.equal(error.message.includes("postgres://"), false);
  assert.equal(error.message.includes("mediaiq_evidence_writer"), false);
  assert.equal(error.message.includes("select private"), false);
  assert.equal(error.cause, undefined);
}

function assertNoClientImport(): void {
  const sourceRoot = path.join(repoRoot, "src");
  const clientFiles = walk(sourceRoot).filter((file) => {
    const text = fs.readFileSync(file, "utf8");
    return text.startsWith('"use client"') || text.startsWith("'use client'");
  });
  assert.ok(clientFiles.length > 0);
  for (const file of clientFiles) {
    const text = fs.readFileSync(file, "utf8");
    assert.equal(text.includes("server/evidence/service"), false);
  }
}

function walk(directory: string): string[] {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return walk(fullPath);
    }
    return entry.isFile() && /\.(ts|tsx|js|mjs)$/.test(entry.name) ? [fullPath] : [];
  });
}

function captureConsole(): void {
  const record = (level: string) => (...parts: unknown[]) => {
    logs.push(`${level}:${parts.map(String).join(" ")}`);
  };
  console.log = record("log");
  console.error = record("error");
  console.warn = record("warn");
  console.info = record("info");
}

function restoreConsole(): void {
  console.log = originalConsole.log;
  console.error = originalConsole.error;
  console.warn = originalConsole.warn;
  console.info = originalConsole.info;
}
