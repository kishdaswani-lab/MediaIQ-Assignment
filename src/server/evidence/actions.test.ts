import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { accessDecision, type AuthContext } from "../auth/policy";
import {
  deleteEvidenceAction,
  listEvidenceAction,
  readEvidenceAction,
  uploadEvidenceAction,
} from "./actions";
import { replaceMiaOperations } from "../mia/dependencies";
import type { MiaRequestRecord } from "../mia/service";
import {
  deleteEvidenceConfirmation,
  replaceEvidenceActionDependencies,
} from "./action-dependencies";
import {
  evidenceUnavailableMessage,
  evidenceUnconfirmedMessage,
  EvidenceServiceError,
  type EvidenceDetail,
  type EvidenceListItem,
} from "./service";
import { CALCULATION_VERSION, MAX_CSV_BYTES, PARSER_VERSION, type EvidenceSummary } from "./types";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const userA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const userB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2";
const forgedOwner = "cccccccc-cccc-4ccc-8ccc-ccccccccccc3";
const workspaceId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const businessId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const evidenceA = "11111111-1111-4111-8111-111111111111";
const evidenceB = "22222222-2222-4222-8222-222222222222";
const missingId = "33333333-3333-4333-8333-333333333333";
const plainCsv = "date,campaign,channel,spend,impressions,clicks\n2024-02-01,Spring,Search,10.10,9,3\n";
const currencyCsv = [
  "date,campaign,channel,spend,impressions,clicks,currency",
  "2024-02-01,Spring,Search,10.10,9,3,USD",
  "2024-02-02,Fall,Social,2.00,4,1,EUR",
].join("\n");
const invalidDateCsv = "date,campaign,channel,spend,impressions,clicks,currency\n2026-02-31,Spring,Search,10.10,9,3,USD\n";
const invalidCurrencyCsv = "date,campaign,channel,spend,impressions,clicks,currency\n2024-02-01,Spring,Search,10.10,9,3,usd\n";

type Snapshot = {
  userId: string;
  email: string;
  emailConfirmed: boolean;
  assurance: "aal1" | "aal2";
  verifiedTotp: boolean;
};

type Call = { method: string; args: unknown[] };

const calls: Call[] = [];
const miaCalls: Call[] = [];
let session: Snapshot | null = protectedUser(userA);
let miaError: Error | null = null;
let insertError: Error | null = null;
let deleteResult = true;
let readOwner = userA;

const detail: EvidenceDetail = {
  id: evidenceA,
  createdAt: "2024-03-01T00:00:00.000Z",
  parserVersion: PARSER_VERSION,
  calculationVersion: CALCULATION_VERSION,
  summary: {
    calculationVersion: CALCULATION_VERSION,
    parserVersion: PARSER_VERSION,
    currencySource: "column",
    period: { start: "2024-02-01", end: "2024-02-02" },
    impressions: "13",
    clicks: "4",
    ctr: { kind: "omitted", reason: "not_exact" },
    currencies: [],
    channels: [],
    campaigns: [],
  },
};

install();

afterEach(() => {
  calls.length = 0;
  miaCalls.length = 0;
  session = protectedUser(userA);
  insertError = null;
  miaError = null;
  deleteResult = true;
  readOwner = userA;
  install();
});

describe("authenticated evidence actions", () => {
  it("does not call the evidence service without a session, AAL2, or verified TOTP", async () => {
    for (const candidate of [null, protectedUser(userA, { assurance: "aal1" }), protectedUser(userA, { verifiedTotp: false })]) {
      calls.length = 0;
      session = candidate;
      await assert.rejects(() => uploadEvidenceAction(validUpload()));
      await assert.rejects(() => listEvidenceAction({}));
      await assert.rejects(() => readEvidenceAction({ evidenceId: evidenceA }));
      await assert.rejects(() => deleteEvidenceAction(deleteInput(evidenceA)));
      assert.equal(calls.length, 0);
      assert.equal(miaCalls.length, 0);
    }
  });

  it("passes snapshot.userId and ignores forged owner, workspace, and business ids", async () => {
    const uploaded = await uploadEvidenceAction(validUpload({ ownerId: forgedOwner, userId: forgedOwner, workspaceId, businessId }));
    assert.equal(uploaded.ok, true);
    assert.equal(calls[0].method, "insert");
    assert.equal(calls[0].args[0], userA);
    assert.equal(calls[0].args.includes(forgedOwner), false);
    assert.equal(calls[0].args.includes(workspaceId), false);
    assert.equal(calls[0].args.includes(businessId), false);

    calls.length = 0;
    const listed = await listEvidenceAction({ limit: 20, ownerId: forgedOwner, workspaceId, businessId, userId: userB });
    assert.equal(listed.ok, true);
    assert.deepEqual(calls[0].args, [userA, 20, null]);

    calls.length = 0;
    await readEvidenceAction({ evidenceId: evidenceA, ownerId: forgedOwner, workspaceId, businessId, userId: userB });
    assert.deepEqual(calls[0].args, [userA, evidenceA]);

    calls.length = 0;
    await deleteEvidenceAction(deleteInput(evidenceA, { ownerId: forgedOwner, workspaceId, businessId, userId: userB }));
    assert.deepEqual(calls[0].args, [userA, evidenceA]);
  });

  it("keeps another user's evidence out of read, list, and delete results", async () => {
    readOwner = userB;
    const foreignRead = await readEvidenceAction({ evidenceId: evidenceB, ownerId: userB });
    const missingRead = await readEvidenceAction({ evidenceId: missingId });
    assert.deepEqual(foreignRead, missingRead);
    assert.equal(foreignRead.ok, false);
    if (!foreignRead.ok) {
      assert.equal(foreignRead.kind, "not_found");
    }
    assert.deepEqual(calls.map((call) => call.args[0]), [userA, userA]);

    calls.length = 0;
    session = protectedUser(userB);
    const listed = await listEvidenceAction({});
    assert.equal(listed.ok, true);
    if (listed.ok) {
      assert.deepEqual(listed.evidence.map((item) => item.id), [evidenceB]);
    }
    assert.equal(calls[0].args[0], userB);
    assert.equal(JSON.stringify(listed).includes(evidenceA), false);

    calls.length = 0;
    session = protectedUser(userA);
    deleteResult = false;
    const deleted = await deleteEvidenceAction(deleteInput(evidenceB));
    assert.equal(deleted.ok, false);
    if (!deleted.ok) {
      assert.equal(deleted.kind, "not_found");
    }
    assert.deepEqual(deleted, foreignRead);
    assert.deepEqual(calls[0].args, [userA, evidenceB]);
  });

  it("rejects an invalid file, a missing currency, and an invalid currency before insert", async () => {
    const oversized = new File([new Uint8Array(MAX_CSV_BYTES + 1)], "big.csv");
    assert.equal((await uploadEvidenceAction(form({ file: oversized }))).ok, false);
    assert.equal((await uploadEvidenceAction(form({ file: csvFile(invalidDateCsv) }))).ok, false);

    const missingCurrency = await uploadEvidenceAction(form({ file: csvFile(plainCsv) }));
    assert.equal(missingCurrency.ok, false);
    if (!missingCurrency.ok) {
      assert.equal(missingCurrency.code, "currency_required");
    }

    const invalidCurrency = await uploadEvidenceAction(form({ file: csvFile(invalidCurrencyCsv), currency: "USD" }));
    assert.equal(invalidCurrency.ok, false);
    if (!invalidCurrency.ok) {
      assert.equal(invalidCurrency.code, "invalid_currency");
    }
    assert.equal(calls.length, 0);
  });

  it("stores a validated file under the signed-in user and does not confirm an ambiguous insert", async () => {
    const uploaded = await uploadEvidenceAction(form({ file: csvFile(currencyCsv), currency: "GBP", ownerId: forgedOwner }));
    assert.equal(uploaded.ok, true);
    if (uploaded.ok) {
      assert.equal(uploaded.evidence.id, evidenceA);
      assert.equal("sourceText" in uploaded.evidence, false);
      assert.equal(uploaded.mia.initialized, true);
    }
    assert.equal(miaCalls[0]?.args[0], userA);
    const summary = calls[0].args[2] as EvidenceSummary;
    assert.equal(calls[0].args[0], userA);
    assert.equal(String(calls[0].args[1]).includes("Spring"), true);
    assert.equal(summary.currencySource, "column");
    assert.deepEqual(summary.currencies.map((item) => item.currency).sort(), ["EUR", "USD"]);
    assert.equal(summary.currencies.some((item) => item.currency === "GBP"), false);
    assert.equal(summary.parserVersion, PARSER_VERSION);

    calls.length = 0;
    const selected = await uploadEvidenceAction(form({ file: csvFile(plainCsv), currency: "USD" }));
    assert.equal(selected.ok, true);
    assert.equal((calls[0].args[2] as EvidenceSummary).currencySource, "upload");
    assert.equal((calls[0].args[2] as EvidenceSummary).currencies[0].currency, "USD");

    insertError = new EvidenceServiceError("unconfirmed", evidenceUnconfirmedMessage);
    const ambiguous = await uploadEvidenceAction(form({ file: csvFile(plainCsv), currency: "USD" }));
    assert.equal(ambiguous.ok, false);
    if (!ambiguous.ok) {
      assert.equal(ambiguous.kind, "unconfirmed");
      assert.equal(ambiguous.message, evidenceUnconfirmedMessage);
    }

    insertError = new EvidenceServiceError("unavailable", evidenceUnavailableMessage);
    const failed = await uploadEvidenceAction(form({ file: csvFile(plainCsv), currency: "USD" }));
    assert.equal(failed.ok, false);
    if (!failed.ok) {
      assert.equal(failed.kind, "unavailable");
      assert.equal(failed.message, evidenceUnavailableMessage);
    }
  });

  it("preserves the list cursor and rejects a bad page before calling the service", async () => {
    const cursor = { beforeCreatedAt: "2024-04-01T00:00:00.000Z", beforeId: evidenceA };
    const page = await listEvidenceAction({ limit: 20, cursor, ownerId: forgedOwner });
    assert.equal(page.ok, true);
    assert.deepEqual(calls[0].args, [userA, 20, { beforeCreatedAt: cursor.beforeCreatedAt, beforeId: evidenceA }]);

    calls.length = 0;
    const first = await listEvidenceAction(undefined);
    assert.equal(first.ok, true);
    assert.deepEqual(calls[0].args, [userA, 20, null]);

    calls.length = 0;
    for (const input of [{ limit: 51 }, { limit: 0 }, { limit: 1.5 }, { cursor: { beforeId: evidenceA } }, { cursor: { beforeCreatedAt: "yesterday", beforeId: evidenceA } }]) {
      const result = await listEvidenceAction(input);
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.kind, "validation");
      }
    }
    assert.equal(calls.length, 0);
  });

  it("requires the approved confirmation and does not report a failed delete as success", async () => {
    const unconfirmed = await deleteEvidenceAction({ evidenceId: evidenceA, confirmation: "delete" });
    assert.equal(unconfirmed.ok, false);
    assert.equal(calls.length, 0);

    deleteResult = false;
    const missing = await deleteEvidenceAction(deleteInput(evidenceA));
    assert.equal(missing.ok, false);
    if (!missing.ok) {
      assert.equal(missing.kind, "not_found");
    }

    insertError = new Error("delete failed postgres://credential@database-host.example");
    const broken = await deleteEvidenceAction(deleteInput(evidenceA));
    assert.equal(broken.ok, false);
    if (!broken.ok) {
      assert.equal(broken.kind, "unavailable");
      assert.equal(broken.message, evidenceUnavailableMessage);
      assert.equal(broken.message.includes("credential"), false);
      assert.equal(broken.message.includes("database-host.example"), false);
    }
  });

  it("imports only on the server and does not open a database connection", () => {
    const source = fs.readFileSync(new URL("./actions.ts", import.meta.url), "utf8");
    const dependencies = fs.readFileSync(new URL("./action-dependencies.ts", import.meta.url), "utf8");
    assert.match(source, /"use server"/);
    assert.match(dependencies, /requireProtectedSession/);
    assert.equal(source.includes("SERVICE_ROLE"), false);
    assert.equal(source.includes("securitySql"), false);

    const blocked = spawnSync(process.execPath, [
      "--import",
      "./src/server/evidence/register-test-hook.mjs",
      "--experimental-strip-types",
      "--input-type=module",
      "--eval",
      "await import('./src/server/evidence/actions.ts');",
    ], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, MEDIAIQ_REQUIRE_SERVER_ONLY: "1" },
    });
    assert.notEqual(blocked.status, 0);
    assert.match(blocked.stderr, /This module cannot be imported from a Client Component module/);

    const imported = spawnSync(process.execPath, [
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
        "await import('./src/server/evidence/actions.ts');",
        "if (calls !== 0) throw new Error('database connection attempted');",
      ].join("\n"),
    ], { cwd: repoRoot, encoding: "utf8" });
    assert.equal(imported.status, 0, imported.stderr);
  });
});

function install(): void {
  replaceEvidenceActionDependencies({
    session: async () => gate(session),
    evidence: {
      async insertEvidence(ownerId, sourceText, summary) {
        calls.push({ method: "insert", args: [ownerId, sourceText, summary] });
        if (insertError) {
          throw insertError;
        }
        return detail;
      },
      async listEvidence(ownerId, limit, cursor) {
        calls.push({ method: "list", args: [ownerId, limit, cursor] });
        const items: EvidenceListItem[] = ownerId === userB ? [listItem(evidenceB)] : [listItem(evidenceA)];
        return items;
      },
      async readEvidence(ownerId, evidenceId) {
        calls.push({ method: "read", args: [ownerId, evidenceId] });
        if (ownerId === readOwner && evidenceId === evidenceA) {
          return detail;
        }
        return null;
      },
      async deleteEvidence(ownerId, evidenceId) {
        calls.push({ method: "delete", args: [ownerId, evidenceId] });
        if (insertError) {
          throw insertError;
        }
        return deleteResult && ownerId === userA && evidenceId === evidenceA;
      },
    },
  });
  replaceMiaOperations({
    async ensurePerformanceSummary(ownerId, evidence) {
      miaCalls.push({ method: "summary", args: [ownerId, evidence.id] });
      if (miaError) {
        throw miaError;
      }
      return summaryRequest();
    },
  });
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

function validUpload(extra: Record<string, string> = {}): FormData {
  return form({ file: csvFile(currencyCsv), currency: "GBP", ...extra });
}

function form(fields: Record<string, string | File>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    data.set(key, value);
  }
  return data;
}

function csvFile(text: string): File {
  return new File([text], "campaign.csv", { type: "text/csv" });
}

function deleteInput(evidenceId: string, extra: Record<string, string> = {}): Record<string, string> {
  return { evidenceId, confirmation: deleteEvidenceConfirmation, ...extra };
}

function summaryRequest(): MiaRequestRecord {
  return {
    requestId: "99999999-9999-4999-8999-999999999999",
    requestType: "performance_summary",
    state: "validating",
    resultCode: "created",
    availability: "awaiting_provider",
    renderedText: null,
    failureCategory: null,
    createdAt: null,
    completedAt: null,
  };
}

function listItem(id: string): EvidenceListItem {
  return {
    id,
    createdAt: "2024-03-01T00:00:00.000Z",
    parserVersion: PARSER_VERSION,
    calculationVersion: CALCULATION_VERSION,
    periodStart: "2024-02-01",
    periodEnd: "2024-02-02",
    campaignCount: 2,
    channelCount: 2,
    currencyCodes: ["USD", "EUR"],
  };
}
