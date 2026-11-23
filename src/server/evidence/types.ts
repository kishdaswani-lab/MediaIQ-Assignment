export const PARSER_VERSION = "monday-csv-1" as const;
export const CALCULATION_VERSION = "campaign-descriptive-1" as const;

/** Provisional Monday limits. They are not a confirmation of Vercel's request size. */
export const MAX_CSV_BYTES = 1024 * 1024;
export const MAX_DATA_ROWS = 2000;
export const MAX_LABEL_LENGTH = 200;

export const REQUIRED_HEADERS = [
  "date",
  "campaign",
  "channel",
  "spend",
  "impressions",
  "clicks",
] as const;

export const OPTIONAL_HEADERS = ["conversions", "revenue", "currency"] as const;

export type KnownHeader =
  | (typeof REQUIRED_HEADERS)[number]
  | (typeof OPTIONAL_HEADERS)[number];

export type EvidenceErrorCode =
  | "file_too_large"
  | "invalid_utf8"
  | "unclosed_quote"
  | "malformed_quote"
  | "missing_header"
  | "unknown_header"
  | "duplicate_header"
  | "missing_required_header"
  | "field_count"
  | "no_data_rows"
  | "too_many_rows"
  | "missing_value"
  | "invalid_date"
  | "invalid_count"
  | "invalid_money"
  | "invalid_currency"
  | "currency_required"
  | "value_too_long";

export type EvidenceError = {
  ok: false;
  code: EvidenceErrorCode;
  message: string;
  recordNumber?: number;
  field?: string;
};

export type ExactDecimal = {
  units: bigint;
  scale: number;
};

export type ValidatedRow = {
  date: string;
  campaign: string;
  channel: string;
  spend: ExactDecimal;
  impressions: bigint;
  clicks: bigint;
  conversions?: bigint;
  revenue?: ExactDecimal;
  /** Row code, or the upload selection when the file has no currency column. */
  currency: string;
};

export type ParsedEvidence = {
  ok: true;
  parserVersion: typeof PARSER_VERSION;
  currencySource: "column" | "upload";
  hasConversions: boolean;
  hasRevenue: boolean;
  /** Decoded UTF-8 text after one leading BOM strip. Present only when validation succeeds. */
  sourceText: string;
  rows: ValidatedRow[];
};

export type ParseResult = ParsedEvidence | EvidenceError;

export type RateResult =
  | { kind: "exact"; value: string }
  | { kind: "omitted"; reason: "zero_denominator" | "not_exact" };

export type CurrencyTotals = {
  currency: string;
  spend: string;
  revenue?: string;
  cpc: RateResult;
  costPerConversion?: RateResult;
  revenuePerSpend?: RateResult;
};

export type GroupTotals = {
  name: string;
  impressions: string;
  clicks: string;
  conversions?: string;
  ctr: RateResult;
  currencies: CurrencyTotals[];
};

export type EvidenceSummary = {
  calculationVersion: typeof CALCULATION_VERSION;
  parserVersion: typeof PARSER_VERSION;
  currencySource: "column" | "upload";
  period: { start: string; end: string };
  impressions: string;
  clicks: string;
  conversions?: string;
  ctr: RateResult;
  currencies: CurrencyTotals[];
  channels: GroupTotals[];
  campaigns: GroupTotals[];
};
