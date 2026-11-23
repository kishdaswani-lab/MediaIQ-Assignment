import { parseMoney } from "./decimal";
import {
  MAX_CSV_BYTES,
  MAX_DATA_ROWS,
  MAX_LABEL_LENGTH,
  OPTIONAL_HEADERS,
  PARSER_VERSION,
  REQUIRED_HEADERS,
  type EvidenceError,
  type KnownHeader,
  type ParsedEvidence,
  type ParseResult,
  type ValidatedRow,
} from "./types";

const HEADER_SET = new Set<string>([...REQUIRED_HEADERS, ...OPTIONAL_HEADERS]);
const COUNT_PATTERN = /^(0|[1-9]\d*)$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

export type ParseOptions = {
  /** Used only when the file has no currency column. It is not written back as a CSV cell. */
  currency?: string;
};

export function parseCampaignCsv(
  bytes: Uint8Array,
  options: ParseOptions = {},
): ParseResult {
  if (bytes.byteLength > MAX_CSV_BYTES) {
    return error("file_too_large", "The file is larger than 1 MiB.");
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return error("invalid_utf8", "The file is not valid UTF-8.");
  }
  if (text.startsWith("\uFEFF")) {
    text = text.slice(1);
  }

  const parsed = parseRecords(text);
  if (!parsed.ok) {
    return parsed;
  }

  const records = parsed.records.filter((record) => !record.every((field) => field === ""));
  const header = records[0];
  if (!header) {
    return error("missing_header", "The file has no header row.");
  }

  const columns = resolveHeaders(header);
  if (!columns.ok) {
    return columns;
  }

  const rows: ValidatedRow[] = [];
  for (const record of records.slice(1)) {
    if (rows.length >= MAX_DATA_ROWS) {
      return error("too_many_rows", "The file has more than 2,000 data rows.");
    }
    const validated = validateRow(record, columns, rows.length + 2);
    if (!validated.ok) {
      return validated;
    }
    rows.push(validated.row);
  }

  if (rows.length === 0) {
    return error("no_data_rows", "The file has no usable data rows.");
  }

  if (columns.currencyIndex === undefined) {
    const selected = options.currency?.trim() ?? "";
    if (selected === "") {
      return error(
        "currency_required",
        "Select one three-letter currency when the file has no currency column.",
        { field: "currency" },
      );
    }
    if (!CURRENCY_PATTERN.test(selected)) {
      return error("invalid_currency", "A currency code is not three letters A-Z.", {
        field: "currency",
      });
    }
    return accepted(
      columns,
      rows.map((row) => ({ ...row, currency: selected })),
      "upload",
      text,
    );
  }

  return accepted(columns, rows, "column", text);
}

function accepted(
  columns: HeaderMap,
  rows: ValidatedRow[],
  currencySource: "column" | "upload",
  sourceText: string,
): ParsedEvidence {
  return {
    ok: true,
    parserVersion: PARSER_VERSION,
    currencySource,
    hasConversions: columns.conversionsIndex !== undefined,
    hasRevenue: columns.revenueIndex !== undefined,
    sourceText,
    rows,
  };
}

type HeaderMap = {
  ok: true;
  indexes: Record<KnownHeader, number | undefined>;
  width: number;
  currencyIndex: number | undefined;
  conversionsIndex: number | undefined;
  revenueIndex: number | undefined;
};

function resolveHeaders(header: string[]): HeaderMap | EvidenceError {
  const indexes = {} as Record<KnownHeader, number | undefined>;
  const seen = new Set<string>();
  for (let index = 0; index < header.length; index += 1) {
    const normalized = header[index].trim().toLowerCase();
    if (!HEADER_SET.has(normalized)) {
      return error("unknown_header", "The file contains an unsupported header.", {
        recordNumber: 1,
        field: header[index].trim(),
      });
    }
    if (seen.has(normalized)) {
      return error("duplicate_header", "Two headers match after trim and case normalization.", {
        recordNumber: 1,
        field: normalized,
      });
    }
    seen.add(normalized);
    indexes[normalized as KnownHeader] = index;
  }

  for (const name of REQUIRED_HEADERS) {
    if (indexes[name] === undefined) {
      return error("missing_required_header", "A required header is missing.", {
        recordNumber: 1,
        field: name,
      });
    }
  }

  return {
    ok: true,
    indexes,
    width: header.length,
    currencyIndex: indexes.currency,
    conversionsIndex: indexes.conversions,
    revenueIndex: indexes.revenue,
  };
}

function validateRow(
  record: string[],
  columns: HeaderMap,
  recordNumber: number,
): { ok: true; row: ValidatedRow } | EvidenceError {
  if (record.length !== columns.width) {
    return error("field_count", "A row has a different number of fields from the header.", {
      recordNumber,
    });
  }

  const read = (name: KnownHeader): string => {
    const index = columns.indexes[name];
    return index === undefined ? "" : record[index].trim();
  };

  const date = read("date");
  const campaign = read("campaign");
  const channel = read("channel");
  const spendText = read("spend");
  const impressionsText = read("impressions");
  const clicksText = read("clicks");

  if (date === "") {
    return missing("date", recordNumber);
  }
  if (!isRealDate(date)) {
    return error("invalid_date", "A date is not a real calendar date in YYYY-MM-DD form.", {
      recordNumber,
      field: "date",
    });
  }
  if (campaign === "") {
    return missing("campaign", recordNumber);
  }
  if ([...campaign].length > MAX_LABEL_LENGTH) {
    return error("value_too_long", "A campaign name is longer than 200 characters.", {
      recordNumber,
      field: "campaign",
    });
  }
  if (channel === "") {
    return missing("channel", recordNumber);
  }
  if ([...channel].length > MAX_LABEL_LENGTH) {
    return error("value_too_long", "A channel name is longer than 200 characters.", {
      recordNumber,
      field: "channel",
    });
  }

  const spend = parseMoney(spendText);
  if (spendText === "") {
    return missing("spend", recordNumber);
  }
  if (!spend) {
    return error("invalid_money", "Spend is not a non-negative dot-decimal amount.", {
      recordNumber,
      field: "spend",
    });
  }
  const impressions = parseCount(impressionsText);
  if (impressionsText === "") {
    return missing("impressions", recordNumber);
  }
  if (impressions === null) {
    return error("invalid_count", "Impressions is not a non-negative integer.", {
      recordNumber,
      field: "impressions",
    });
  }
  const clicks = parseCount(clicksText);
  if (clicksText === "") {
    return missing("clicks", recordNumber);
  }
  if (clicks === null) {
    return error("invalid_count", "Clicks is not a non-negative integer.", {
      recordNumber,
      field: "clicks",
    });
  }

  const row: ValidatedRow = {
    date,
    campaign,
    channel,
    spend,
    impressions,
    clicks,
    currency: "",
  };

  if (columns.conversionsIndex !== undefined) {
    const text = read("conversions");
    if (text === "") {
      return missing("conversions", recordNumber);
    }
    const conversions = parseCount(text);
    if (conversions === null) {
      return error("invalid_count", "Conversions is not a non-negative integer.", {
        recordNumber,
        field: "conversions",
      });
    }
    row.conversions = conversions;
  }

  if (columns.revenueIndex !== undefined) {
    const text = read("revenue");
    if (text === "") {
      return missing("revenue", recordNumber);
    }
    const revenue = parseMoney(text);
    if (!revenue) {
      return error("invalid_money", "Revenue is not a non-negative dot-decimal amount.", {
        recordNumber,
        field: "revenue",
      });
    }
    row.revenue = revenue;
  }

  if (columns.currencyIndex !== undefined) {
    const currency = read("currency");
    if (currency === "") {
      return missing("currency", recordNumber);
    }
    if (!CURRENCY_PATTERN.test(currency)) {
      return error("invalid_currency", "A currency code is not three letters A-Z.", {
        recordNumber,
        field: "currency",
      });
    }
    row.currency = currency;
  }

  return { ok: true, row };
}

function parseRecords(
  text: string,
): { ok: true; records: string[][] } | EvidenceError {
  const records: string[][] = [];
  const length = text.length;
  let index = 0;

  while (index < length) {
    const fields: string[] = [];
    for (;;) {
      if (index >= length) {
        break;
      }
      if (text[index] === "\"") {
        index += 1;
        let value = "";
        let closed = false;
        while (index < length) {
          if (text[index] === "\"") {
            if (text[index + 1] === "\"") {
              value += "\"";
              index += 2;
              continue;
            }
            index += 1;
            closed = true;
            break;
          }
          value += text[index];
          index += 1;
        }
        if (!closed) {
          return error("unclosed_quote", "A quoted field is not closed.");
        }
        fields.push(value);
      } else {
        let value = "";
        while (
          index < length &&
          text[index] !== "," &&
          text[index] !== "\n" &&
          text[index] !== "\r"
        ) {
          if (text[index] === "\"") {
            return error("malformed_quote", "A quote appears outside a quoted field.");
          }
          value += text[index];
          index += 1;
        }
        fields.push(value);
      }

      if (index >= length) {
        break;
      }
      if (text[index] === ",") {
        index += 1;
        if (index >= length) {
          fields.push("");
          break;
        }
        continue;
      }
      if (text[index] === "\r") {
        index += 1;
        if (text[index] === "\n") {
          index += 1;
        }
        break;
      }
      if (text[index] === "\n") {
        index += 1;
        break;
      }
      return error("malformed_quote", "A quoted field is not followed by a comma or line break.");
    }
    records.push(fields);
  }

  return { ok: true, records };
}

function isRealDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value);
  if (!match) {
    return false;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) {
    return false;
  }
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day >= 1 && day <= days[month - 1];
}

function parseCount(value: string): bigint | null {
  if (!COUNT_PATTERN.test(value)) {
    return null;
  }
  return BigInt(value);
}

function missing(field: string, recordNumber: number): EvidenceError {
  return error("missing_value", "A required cell is empty.", { recordNumber, field });
}

function error(
  code: EvidenceError["code"],
  message: string,
  extra: { recordNumber?: number; field?: string } = {},
): EvidenceError {
  return { ok: false, code, message, ...extra };
}
