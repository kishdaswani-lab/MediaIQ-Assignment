import "server-only";
import type { EvidenceSummary } from "./types";
import { evidenceSql } from "./pool";

export const evidenceUnavailableMessage = "The evidence request could not be completed.";
export const evidenceUnconfirmedMessage =
  "The evidence could not be confirmed. Refresh the list before submitting the file again.";
export const evidenceInvalidPageMessage = "The evidence page is not valid.";

const poolMessages = new Set([
  "evidence writer is not configured",
  "evidence writer production connections are not approved",
  "evidence writer is server only",
]);

export class EvidenceServiceError extends Error {
  readonly kind: "unavailable" | "unconfirmed" | "invalid";

  constructor(kind: "unavailable" | "unconfirmed" | "invalid", message: string) {
    super(message);
    this.name = "EvidenceServiceError";
    this.kind = kind;
  }
}

export type EvidenceCursor = {
  beforeCreatedAt: string;
  beforeId: string;
};

export type EvidenceListItem = {
  id: string;
  createdAt: string;
  parserVersion: string;
  calculationVersion: string;
  periodStart: string | null;
  periodEnd: string | null;
  campaignCount: number | null;
  channelCount: number | null;
  currencyCodes: string[];
};

export type EvidenceDetail = {
  id: string;
  createdAt: string;
  parserVersion: string;
  calculationVersion: string;
  summary: EvidenceSummary;
};

type EvidenceSql = {
  (query: TemplateStringsArray, ...values: readonly unknown[]): Promise<unknown>;
  json(value: unknown): unknown;
};

type DetailRow = {
  id: unknown;
  created_at: unknown;
  summary: unknown;
  parser_version: unknown;
  calculation_version: unknown;
};

type ListRow = {
  id: unknown;
  created_at: unknown;
  parser_version: unknown;
  calculation_version: unknown;
  period_start: unknown;
  period_end: unknown;
  campaign_count: unknown;
  channel_count: unknown;
  currency_codes: unknown;
};

let openDatabase: () => EvidenceSql = () => evidenceSql() as unknown as EvidenceSql;

export function replaceEvidenceDatabase(next?: () => EvidenceSql): void {
  openDatabase = next ?? (() => evidenceSql() as unknown as EvidenceSql);
}

export async function insertEvidence(
  ownerId: string,
  sourceText: string,
  summary: EvidenceSummary,
): Promise<EvidenceDetail> {
  const sql = database();
  let insertedId: string;
  try {
    const inserted = (await sql`
      select private.insert_campaign_evidence(
        ${ownerId}::uuid,
        ${sourceText},
        ${sql.json(summary)},
        ${summary.parserVersion},
        ${summary.calculationVersion}
      ) as id
    `) as { id: unknown }[];
    const id = inserted[0]?.id;
    if (typeof id !== "string" || id.length === 0) {
      throw new EvidenceServiceError("unavailable", evidenceUnavailableMessage);
    }
    insertedId = id;
  } catch (error) {
    throw publish(error, insertFailureKind(error));
  }

  try {
    const rows = (await sql`
      select id, created_at, summary, parser_version, calculation_version
      from private.read_campaign_evidence(${ownerId}::uuid, ${insertedId}::uuid)
    `) as DetailRow[];
    const detail = mapDetail(rows[0]);
    if (!detail || detail.id !== insertedId) {
      throw new EvidenceServiceError("unconfirmed", evidenceUnconfirmedMessage);
    }
    return detail;
  } catch (error) {
    throw publish(error, "unconfirmed");
  }
}

export async function readEvidence(
  ownerId: string,
  evidenceId: string,
): Promise<EvidenceDetail | null> {
  const sql = database();
  try {
    const rows = (await sql`
      select id, created_at, summary, parser_version, calculation_version
      from private.read_campaign_evidence(${ownerId}::uuid, ${evidenceId}::uuid)
    `) as DetailRow[];
    if (rows.length === 0) {
      return null;
    }
    const detail = mapDetail(rows[0]);
    if (!detail) {
      throw new EvidenceServiceError("unavailable", evidenceUnavailableMessage);
    }
    return detail;
  } catch (error) {
    throw publish(error, "unavailable");
  }
}

export async function listEvidence(
  ownerId: string,
  limit: number,
  cursor: EvidenceCursor | null,
): Promise<EvidenceListItem[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new EvidenceServiceError("invalid", evidenceInvalidPageMessage);
  }
  if (cursor && (!presentText(cursor.beforeCreatedAt) || !presentText(cursor.beforeId))) {
    throw new EvidenceServiceError("invalid", evidenceInvalidPageMessage);
  }

  const sql = database();
  try {
    const rows = (await sql`
      select
        id,
        created_at,
        parser_version,
        calculation_version,
        period_start,
        period_end,
        campaign_count,
        channel_count,
        currency_codes
      from private.list_campaign_evidence(
        ${ownerId}::uuid,
        ${limit},
        ${cursor ? cursor.beforeCreatedAt : null},
        ${cursor ? cursor.beforeId : null}
      )
    `) as ListRow[];
    return rows.map((row) => {
      const item = mapListItem(row);
      if (!item) {
        throw new EvidenceServiceError("unavailable", evidenceUnavailableMessage);
      }
      return item;
    });
  } catch (error) {
    throw publish(error, "unavailable");
  }
}

export async function deleteEvidence(ownerId: string, evidenceId: string): Promise<boolean> {
  const sql = database();
  try {
    const deleted = (await sql`
      select private.delete_campaign_evidence(${ownerId}::uuid, ${evidenceId}::uuid) as id
    `) as { id: unknown }[];
    return deleted[0]?.id === evidenceId;
  } catch (error) {
    throw publish(error, "unavailable");
  }
}

function database(): EvidenceSql {
  try {
    return openDatabase();
  } catch (error) {
    throw publish(error, "unavailable");
  }
}

function publish(error: unknown, kind: "unavailable" | "unconfirmed"): Error {
  if (error instanceof EvidenceServiceError) {
    return error;
  }
  if (error instanceof Error && poolMessages.has(error.message)) {
    return error;
  }
  return new EvidenceServiceError(kind, kind === "unconfirmed" ? evidenceUnconfirmedMessage : evidenceUnavailableMessage);
}

function insertFailureKind(error: unknown): "unavailable" | "unconfirmed" {
  if (error instanceof EvidenceServiceError) {
    return error.kind === "unconfirmed" ? "unconfirmed" : "unavailable";
  }
  const code = readCode(error);
  if (/^(22|23|42)/.test(code) || code === "53300" || code === "ECONNREFUSED" || code === "ENOTFOUND" || code === "CONNECT_TIMEOUT") {
    return "unavailable";
  }
  return "unconfirmed";
}

function readCode(error: unknown): string {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return "";
  }
  const code = error.code;
  return typeof code === "string" ? code : "";
}

function mapDetail(row: DetailRow | undefined): EvidenceDetail | null {
  if (!row) {
    return null;
  }
  const id = text(row.id);
  const createdAt = timestamp(row.created_at);
  const parserVersion = text(row.parser_version);
  const calculationVersion = text(row.calculation_version);
  const summary = copySummary(row.summary);
  if (!id || !createdAt || !parserVersion || !calculationVersion || !summary) {
    return null;
  }
  return { id, createdAt, parserVersion, calculationVersion, summary };
}

function mapListItem(row: ListRow): EvidenceListItem | null {
  const id = text(row.id);
  const createdAt = timestamp(row.created_at);
  const parserVersion = text(row.parser_version);
  const calculationVersion = text(row.calculation_version);
  const periodStart = nullableText(row.period_start);
  const periodEnd = nullableText(row.period_end);
  const campaignCount = nullableCount(row.campaign_count);
  const channelCount = nullableCount(row.channel_count);
  const currencyCodes = currencyList(row.currency_codes);
  if (!id || !createdAt || !parserVersion || !calculationVersion || periodStart === undefined || periodEnd === undefined || campaignCount === undefined || channelCount === undefined || !currencyCodes) {
    return null;
  }
  return {
    id,
    createdAt,
    parserVersion,
    calculationVersion,
    periodStart,
    periodEnd,
    campaignCount,
    channelCount,
    currencyCodes,
  };
}

function copySummary(value: unknown): EvidenceSummary | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return { ...(value as EvidenceSummary) };
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function presentText(value: string): boolean {
  return typeof value === "string" && value.length > 0;
}

function nullableText(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }
  return typeof value === "string" ? value : undefined;
}

function nullableCount(value: unknown): number | null | undefined {
  if (value === null) {
    return null;
  }
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function currencyList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    return null;
  }
  return value.slice();
}

function timestamp(value: unknown): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString();
  }
  return typeof value === "string" && value.length > 0 ? value : null;
}
