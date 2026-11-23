import "server-only";
import { miaMetrics, type EvidencePacket } from "./engine";

export const MIA_PROVIDER = "openai";
export const MIA_MODEL = "gpt-6-luna";
export const MIA_MAX_INPUT_TOKENS = 3000;
export const MIA_MAX_OUTPUT_TOKENS = 500;
export const MIA_TIMEOUT_MS = 30_000;

/**
 * Room withheld because the provider may count framing that is not in the
 * HTTP body. This is not a measurement and it is not a claim that the
 * provider adds this many tokens. The sent text is checked separately.
 * Provider-reported input tokens are checked later, by the database, against
 * the same 3,000-token ceiling.
 */
export const MIA_INPUT_FRAMING_UNCERTAINTY = 256;

export const inputLimitMessage = "This evidence is too large to send within the 3,000-token input limit.";

export type ProviderUsage = {
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  otherBillableTokens: number | null;
};

export type ProviderDisposition = "completed" | "refused" | "incomplete" | "failed" | "unverified";

export const providerRefusalMessage = "MIA cannot use a provider refusal as an evidence answer.";

export const providerFailureCategory = {
  refusal: "provider_refusal",
  incomplete: "incomplete_response",
  failed: "provider_failed",
  unverified: "unverified_provider",
} as const;

export type TransportOutcome = "network" | "http_rejected" | "malformed_response" | "timeout" | "accepted";

export type ProviderTransport = {
  outcome: TransportOutcome;
  httpResponseReceived: boolean;
  httpStatus: number | null;
  providerRequestId: string | null;
};

export type ProviderResult = {
  disposition: ProviderDisposition;
  output: unknown;
  usage: ProviderUsage;
  latencyMs: number;
  transport?: ProviderTransport;
};

const providerRequestIdPattern = /^[A-Za-z0-9._:-]{1,200}$/;

export function sanitizeProviderRequestId(value: string | null | undefined): string | null {
  if (typeof value !== "string" || !providerRequestIdPattern.test(value)) {
    return null;
  }
  return value;
}

export function usageFieldsValidated(usage: ProviderUsage): boolean {
  const { inputTokens, cachedInputTokens, outputTokens, otherBillableTokens } = usage;
  return inputTokens !== null
    && cachedInputTokens !== null
    && outputTokens !== null
    && otherBillableTokens === null
    && inputTokens >= 0
    && cachedInputTokens >= 0
    && outputTokens >= 0
    && cachedInputTokens <= inputTokens
    && inputTokens <= MIA_MAX_INPUT_TOKENS
    && outputTokens <= MIA_MAX_OUTPUT_TOKENS;
}

export const transportFailureCategory = {
  network: "provider_unreachable",
  http_rejected: "provider_rejected",
  malformed_response: "provider_response_unusable",
  timeout: "timeout",
} as const;

export type MiaProviderClient = {
  respond(input: {
    model: string;
    body: string;
    maxOutputTokens: number;
    timeoutMs: number;
  }): Promise<ProviderResult>;
};

const instructions = "Use only the tab-separated evidence. Reference columns are metric, dimension, value, and unit. Return fact and comparison references from those lines. Do not include amounts, recommendations, causes, benchmarks, or predictions.";

export type MiaInputParts = {
  instructions: number;
  question: number;
  evidence: number;
  envelope: number;
  body: number;
  framingUncertainty: number;
};

let testClient: MiaProviderClient | null = null;

export function useMiaProviderClient(next: MiaProviderClient | null): void {
  testClient = next;
}

export function miaProviderClient(): MiaProviderClient | null {
  if (testClient) {
    return testClient;
  }
  if (process.env.NODE_TEST_CONTEXT) {
    return null;
  }
  const key = process.env.MEDIAIQ_OPENAI_API_KEY;
  if (typeof key !== "string" || key.length === 0) {
    return null;
  }
  return realClient(key);
}

export function miaModelRequest(packet: EvidencePacket, question: string | null): string | null {
  const assessment = assessMiaInput(packet, question);
  return assessment.withinCeiling ? assessment.request : null;
}

/**
 * Byte lengths are upper bounds on token count, because a token spans at
 * least one byte. They are not a conversion rate and they are not the
 * provider's reported input-token count.
 */
export function assessMiaInput(packet: EvidencePacket, question: string | null): MiaInputParts & {
  withinCeiling: boolean;
  request: string;
} {
  const evidence = evidenceText(packet);
  const input = inputText(evidence, question);
  const request = requestBody(input);
  const instructionsInBody = encodedLength(instructions);
  const inputInBody = encodedLength(input);
  const body = tokenUpperBound(request);
  return {
    instructions: tokenUpperBound(instructions),
    question: tokenUpperBound(question ?? ""),
    evidence: tokenUpperBound(evidence),
    envelope: body - instructionsInBody - inputInBody,
    body,
    framingUncertainty: MIA_INPUT_FRAMING_UNCERTAINTY,
    withinCeiling: body + MIA_INPUT_FRAMING_UNCERTAINTY <= MIA_MAX_INPUT_TOKENS,
    request,
  };
}

/** Upper bound on token count. A token is at least one byte, so this is not a byte-to-token rate. */
export function tokenUpperBound(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function encodedLength(value: string): number {
  const encoded = JSON.stringify(value);
  return tokenUpperBound(encoded.slice(1, -1));
}

function evidenceText(packet: EvidencePacket): string {
  const lines = [
    `id\t${field(packet.evidenceId)}`,
    `period\t${field(packet.period.start)}\t${field(packet.period.end)}`,
    `currencies\t${packet.currencyCodes.map(field).join("\t")}`,
    `channels\t${packet.channels.map(field).join("\t")}`,
    `campaigns\t${packet.campaigns.map(field).join("\t")}`,
    "references",
  ];
  for (const fact of packet.available) {
    const reference = fact.reference;
    lines.push([
      reference.metricId,
      reference.dimension,
      field(reference.dimensionValue),
      field(reference.unit),
    ].join("\t"));
  }
  return lines.join("\n");
}

function inputText(evidence: string, question: string | null): string {
  return `${evidence}\nquestion\t${question === null ? "" : field(question)}`;
}

function field(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\n/g, "\\n");
}

export function responseSchema(): Record<string, unknown> {
  const fact = { $ref: "#/$defs/fact" };
  return {
    type: "object",
    additionalProperties: false,
    required: ["facts", "comparisons"],
    $defs: {
      fact: {
        type: "object",
        additionalProperties: false,
        required: ["metricId", "dimension", "dimensionValue", "period", "unit", "evidenceId"],
        properties: {
          metricId: { type: "string", enum: [...miaMetrics] },
          dimension: { type: "string", enum: ["file", "channel", "campaign"] },
          dimensionValue: { type: "string" },
          period: {
            type: "object",
            additionalProperties: false,
            required: ["start", "end"],
            properties: {
              start: { type: "string" },
              end: { type: "string" },
            },
          },
          unit: { type: "string" },
          evidenceId: { type: "string" },
        },
      },
    },
    properties: {
      facts: { type: "array", items: fact },
      comparisons: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["left", "right", "relation"],
          properties: {
            left: fact,
            right: fact,
            relation: { type: "string", enum: ["gt", "lt", "eq"] },
          },
        },
      },
    },
  };
}

export function readProviderResponse(payload: unknown): {
  disposition: ProviderDisposition;
  output: unknown;
  usage: ProviderUsage;
} | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const record = payload as {
    status?: unknown;
    output?: unknown;
    usage?: {
      input_tokens?: unknown;
      output_tokens?: unknown;
      input_tokens_details?: { cached_tokens?: unknown };
      total_tokens?: unknown;
    };
  };
  const usage = readUsage(record.usage);
  const status = record.status;
  if (status !== "completed" && status !== "incomplete" && status !== "failed") {
    return { disposition: "unverified", output: null, usage };
  }
  if (hasRefusal(record.output)) {
    return { disposition: "refused", output: null, usage };
  }
  if (status === "incomplete" || status === "failed") {
    return { disposition: status, output: null, usage };
  }
  return { disposition: "completed", output: structuredOutput(record.output), usage };
}

function emptyProviderUsage(): ProviderUsage {
  return {
    inputTokens: null,
    cachedInputTokens: null,
    outputTokens: null,
    otherBillableTokens: null,
  };
}

function transportFailure(
  outcome: Exclude<TransportOutcome, "accepted">,
  latencyMs: number,
  httpStatus: number | null,
  providerRequestId: string | null,
): ProviderResult {
  const httpResponseReceived = outcome === "http_rejected" || outcome === "malformed_response";
  return {
    disposition: "failed",
    output: null,
    usage: emptyProviderUsage(),
    latencyMs,
    transport: {
      outcome,
      httpResponseReceived,
      httpStatus: httpResponseReceived ? httpStatus : null,
      providerRequestId: httpResponseReceived ? providerRequestId : null,
    },
  };
}

export async function executeProviderRequest(
  apiKey: string,
  body: string,
  timeoutMs: number,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderResult> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const elapsed = () => Date.now() - started;
  try {
    let response: Response;
    try {
      response = await fetchImpl("https://api.openai.com/v1/responses", {
        method: "POST",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body,
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === "AbortError";
      return transportFailure(timedOut ? "timeout" : "network", elapsed(), null, null);
    }
    const requestId = sanitizeProviderRequestId(response.headers.get("x-request-id"));
    if (!response.ok) {
      const status = response.status >= 100 && response.status <= 599 ? response.status : null;
      if (status === null) {
        return transportFailure("network", elapsed(), null, null);
      }
      return transportFailure("http_rejected", elapsed(), status, requestId);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return transportFailure("malformed_response", elapsed(), response.status, requestId);
    }
    const parsed = readProviderResponse(payload);
    if (!parsed) {
      return transportFailure("malformed_response", elapsed(), response.status, requestId);
    }
    return {
      disposition: parsed.disposition,
      output: parsed.output,
      usage: parsed.usage,
      latencyMs: elapsed(),
      transport: {
        outcome: "accepted",
        httpResponseReceived: true,
        httpStatus: response.status,
        providerRequestId: requestId,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}

function requestBody(input: string): string {
  return JSON.stringify({
    model: MIA_MODEL,
    store: false,
    max_output_tokens: MIA_MAX_OUTPUT_TOKENS,
    instructions,
    input,
    text: {
      format: {
        type: "json_schema",
        name: "mia_evidence_references",
        strict: true,
        schema: responseSchema(),
      },
    },
  });
}

function realClient(apiKey: string): MiaProviderClient {
  return {
    async respond(input) {
      return executeProviderRequest(apiKey, input.body, input.timeoutMs);
    },
  };
}

function readUsage(usage: {
  input_tokens?: unknown;
  output_tokens?: unknown;
  input_tokens_details?: { cached_tokens?: unknown };
  total_tokens?: unknown;
} | undefined): ProviderUsage {
  const inputTokens = count(usage?.input_tokens);
  const outputTokens = count(usage?.output_tokens);
  const totalTokens = count(usage?.total_tokens);
  const explained = inputTokens !== null && outputTokens !== null ? inputTokens + outputTokens : null;
  return {
    inputTokens,
    cachedInputTokens: count(usage?.input_tokens_details?.cached_tokens),
    outputTokens,
    otherBillableTokens: totalTokens !== null && explained !== null && totalTokens > explained
      ? totalTokens - explained
      : null,
  };
}

function hasRefusal(output: unknown): boolean {
  if (!Array.isArray(output)) {
    return false;
  }
  for (const item of output) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as { type?: unknown; content?: unknown };
    if (record.type === "refusal") {
      return true;
    }
    if (!Array.isArray(record.content)) {
      continue;
    }
    for (const part of record.content) {
      if (!part || typeof part !== "object") {
        continue;
      }
      if ((part as { type?: unknown }).type === "refusal") {
        return true;
      }
    }
  }
  return false;
}

function structuredOutput(output: unknown): unknown {
  const text = outputText(output);
  if (text === null) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function outputText(output: unknown): string | null {
  if (!Array.isArray(output)) {
    return null;
  }
  for (const item of output) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) {
      continue;
    }
    for (const part of content) {
      if (!part || typeof part !== "object") {
        continue;
      }
      const text = (part as { text?: unknown }).text;
      if (typeof text === "string") {
        return text;
      }
    }
  }
  return null;
}

function count(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}
