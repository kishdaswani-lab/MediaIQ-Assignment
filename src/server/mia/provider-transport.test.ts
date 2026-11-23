import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { CALCULATION_VERSION, PARSER_VERSION, type EvidenceSummary } from "@/server/evidence/types";
import {
  executeProviderRequest,
  MIA_MODEL,
  sanitizeProviderRequestId,
  usageFieldsValidated,
  useMiaProviderClient,
  type MiaProviderClient,
  type ProviderResult,
} from "./provider";
import { dispatchValidatedRequest, replaceMiaDatabase, type MiaRequestRecord } from "./service";

const evidenceId = "11111111-1111-4111-8111-111111111111";
const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const calls: { text: string; values: unknown[] }[] = [];

afterEach(() => {
  calls.length = 0;
  useMiaProviderClient(null);
  replaceMiaDatabase();
});

describe("provider transport diagnostics", () => {
  it("classifies a fetch throw as a network failure without an HTTP response", async () => {
    let fetches = 0;
    const result = await executeProviderRequest("local-test-key", "{}", 1000, async () => {
      fetches += 1;
      throw new TypeError("fetch failed");
    });
    assert.equal(fetches, 1);
    assert.equal(result.transport?.outcome, "network");
    assert.equal(result.transport?.httpResponseReceived, false);
    assert.equal(result.transport?.httpStatus, null);
    assert.equal(result.transport?.providerRequestId, null);
    assert.equal(usageFieldsValidated(result.usage), false);
    assert.equal(JSON.stringify(result).includes("local-test-key"), false);
    assert.equal(JSON.stringify(result).includes("fetch failed"), false);
  });

  it("classifies an abort as a timeout without an HTTP response", async () => {
    let fetches = 0;
    const result = await executeProviderRequest("local-test-key", "{}", 20, (_input, init) => {
      fetches += 1;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    });
    assert.equal(fetches, 1);
    assert.equal(result.transport?.outcome, "timeout");
    assert.equal(result.transport?.httpResponseReceived, false);
    assert.equal(result.transport?.httpStatus, null);
    assert.equal(result.latencyMs >= 0, true);
  });

  it("classifies non-2xx responses and keeps a sanitized request id", async () => {
    for (const status of [401, 429, 400, 422, 500]) {
      const result = await executeProviderRequest("local-test-key", "{}", 1000, async () =>
        httpResult(status, "SECRET-BODY", "req_ok.1"));
      assert.equal(result.transport?.outcome, "http_rejected");
      assert.equal(result.transport?.httpResponseReceived, true);
      assert.equal(result.transport?.httpStatus, status);
      assert.equal(result.transport?.providerRequestId, "req_ok.1");
      assert.equal(result.output, null);
      assert.equal(JSON.stringify(result).includes("SECRET-BODY"), false);
      assert.equal(JSON.stringify(result).includes("Bearer"), false);
    }
  });

  it("classifies a 2xx body that is not a provider object as malformed", async () => {
    const invalid = await executeProviderRequest("local-test-key", "{}", 1000, async () =>
      httpResult(200, "not-json", "req_malformed"));
    assert.equal(invalid.transport?.outcome, "malformed_response");
    assert.equal(invalid.transport?.httpStatus, 200);
    assert.equal(invalid.transport?.providerRequestId, "req_malformed");
    assert.equal(JSON.stringify(invalid).includes("not-json"), false);

    const arrayBody = await executeProviderRequest("local-test-key", "{}", 1000, async () =>
      httpResult(200, "[]", null));
    assert.equal(arrayBody.transport?.outcome, "malformed_response");
    assert.equal(arrayBody.transport?.providerRequestId, null);
  });

  it("accepts a valid response with or without a provider request id", async () => {
    const withId = await executeProviderRequest("local-test-key", "{}", 1000, async () =>
      httpResult(200, completedBody(), "req_valid_1"));
    assert.equal(withId.transport?.outcome, "accepted");
    assert.equal(withId.disposition, "completed");
    assert.equal(withId.transport?.providerRequestId, "req_valid_1");
    assert.equal(withId.transport?.httpStatus, 200);
    assert.equal(usageFieldsValidated(withId.usage), true);

    const withoutId = await executeProviderRequest("local-test-key", "{}", 1000, async () =>
      httpResult(200, completedBody(), null));
    assert.equal(withoutId.transport?.outcome, "accepted");
    assert.equal(withoutId.transport?.providerRequestId, null);
    assert.equal(withoutId.disposition, "completed");
  });

  it("drops an invalid or oversized provider request id", () => {
    assert.equal(sanitizeProviderRequestId("req_ok.1"), "req_ok.1");
    assert.equal(sanitizeProviderRequestId("bad id"), null);
    assert.equal(sanitizeProviderRequestId("x".repeat(201)), null);
    assert.equal(sanitizeProviderRequestId("Bearer secret"), null);
    assert.equal(sanitizeProviderRequestId(null), null);
  });

  it("records an HTTP rejection without releasing unknown billing", async () => {
    const rejected = await executeProviderRequest("local-test-key", "{}", 1000, async () =>
      httpResult(401, "SECRET-BODY", "req_denied"));
    installDatabase([
      [{ authorized: true, provider: "openai", model: MIA_MODEL }],
      [],
      [stored("failed", null, "provider_rejected")],
    ]);
    useMiaProviderClient(client(async () => rejected));
    const result = await dispatchValidatedRequest(
      ownerId,
      identity(smallSummary()),
      request(),
      "What is the clicks for the file?",
    );
    assert.equal(result.state, "failed");
    assert.equal(result.failureCategory, "provider_rejected");
    const recorded = calls.find((call) => call.text.includes("record_mia_attempt_outcome"));
    assert.ok(recorded);
    assert.equal(recorded.values[3], "failed");
    assert.equal(recorded.values[4], "unknown");
    assert.equal(recorded.values[5], null);
    assert.equal(recorded.values[9], null);
    assert.equal(recorded.values[14], null);
    assert.equal(recorded.values[15], null);
    assert.equal(recorded.values[17], "http_rejected");
    assert.equal(recorded.values[18], true);
    assert.equal(recorded.values[19], 401);
    assert.equal(recorded.values[20], "req_denied");
    assert.equal(recorded.values[21], false);
    assert.equal(JSON.stringify(recorded.values).includes("SECRET-BODY"), false);
    assert.equal(calls.filter((call) => call.text.includes("record_mia_attempt_outcome")).length, 1);
  });

  it("keeps invalid usage unvalidated and valid usage validated", () => {
    assert.equal(usageFieldsValidated({
      inputTokens: 20,
      cachedInputTokens: 0,
      outputTokens: 8,
      otherBillableTokens: null,
    }), true);
    assert.equal(usageFieldsValidated({
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      otherBillableTokens: null,
    }), false);
    assert.equal(usageFieldsValidated({
      inputTokens: 20,
      cachedInputTokens: 0,
      outputTokens: 8,
      otherBillableTokens: 3,
    }), false);
    assert.equal(usageFieldsValidated({
      inputTokens: 20,
      cachedInputTokens: 30,
      outputTokens: 8,
      otherBillableTokens: null,
    }), false);
  });

  it("persists a timeout without a second fetch or a released reservation", async () => {
    let fetches = 0;
    const timedOut = await executeProviderRequest("local-test-key", "{}", 20, (_input, init) => {
      fetches += 1;
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    });
    const recorded = await recordResult(timedOut, "timed_out");
    assert.equal(fetches, 1);
    assert.equal(recorded.values[3], "timed_out");
    assert.equal(recorded.values[4], "unknown");
    assert.equal(recorded.values[9], null);
    assert.equal(recorded.values[13], "timeout");
    assert.equal(recorded.values[17], "timeout");
    assert.equal(recorded.values[18], false);
    assert.equal(recorded.values[19], null);
    assert.equal(recorded.values[20], null);
    assert.equal(recorded.values[21], false);
  });

  it("persists a malformed response without the response body", async () => {
    const malformed = await executeProviderRequest("local-test-key", "{}", 1000, async () =>
      httpResult(200, "SECRET-BODY", "bad id"));
    const recorded = await recordResult(malformed, "failed");
    assert.equal(recorded.values[3], "failed");
    assert.equal(recorded.values[4], "unknown");
    assert.equal(recorded.values[9], null);
    assert.equal(recorded.values[13], "provider_response_unusable");
    assert.equal(recorded.values[17], "malformed_response");
    assert.equal(recorded.values[18], true);
    assert.equal(recorded.values[19], 200);
    assert.equal(recorded.values[20], null);
    assert.equal(recorded.values[21], false);
    assert.equal(JSON.stringify(recorded.values).includes("SECRET-BODY"), false);
    assert.equal(JSON.stringify(recorded.values).includes("bad id"), false);
  });

  it("keeps missing usage unknown and sends invalid usage for database reconciliation", async () => {
    const missing = await recordResult({
      disposition: "completed",
      output: { facts: [], comparisons: [] },
      usage: { inputTokens: null, cachedInputTokens: null, outputTokens: null, otherBillableTokens: null },
      latencyMs: 12,
      transport: { outcome: "accepted", httpResponseReceived: true, httpStatus: 200, providerRequestId: null },
    }, "reconciliation_required");
    assert.equal(missing.values[3], "reconciliation_required");
    assert.equal(missing.values[4], "unknown");
    assert.equal(missing.values[5], null);
    assert.equal(missing.values[9], null);
    assert.equal(missing.values[13], "unreconciled_billing");
    assert.equal(missing.values[21], false);

    const invalid = await recordResult({
      disposition: "completed",
      output: { facts: [], comparisons: [] },
      usage: { inputTokens: 20, cachedInputTokens: 30, outputTokens: 8, otherBillableTokens: null },
      latencyMs: 12,
      transport: { outcome: "accepted", httpResponseReceived: true, httpStatus: 200, providerRequestId: "req_valid_1" },
    }, "completed");
    assert.equal(invalid.values[4], "reported");
    assert.equal(invalid.values[5], 20);
    assert.equal(invalid.values[6], 8);
    assert.equal(invalid.values[16], 30);
    assert.equal(invalid.values[21], false);
  });

  it("records one unknown outcome when the provider client throws", async () => {
    installDatabase([
      [{ authorized: true, provider: "openai", model: MIA_MODEL }],
      [],
      [stored("failed", null, "provider_error")],
    ]);
    useMiaProviderClient(client(async () => {
      throw new Error("SECRET-THROWN raw provider body");
    }));
    const result = await dispatchValidatedRequest(
      ownerId,
      identity(smallSummary()),
      request(),
      "What is the clicks for the file?",
    );
    assert.equal(result.failureCategory, "provider_error");
    const recorded = calls.find((call) => call.text.includes("record_mia_attempt_outcome"));
    assert.ok(recorded);
    assert.equal(recorded.values[4], "unknown");
    assert.equal(recorded.values[9], null);
    assert.equal(recorded.values[17], null);
    assert.equal(recorded.values[21], false);
    assert.equal(JSON.stringify(recorded.values).includes("SECRET-THROWN"), false);
    assert.equal(calls.filter((call) => call.text.includes("record_mia_attempt_outcome")).length, 1);
  });

  it("does not claim or record a request that is no longer validating", async () => {
    useMiaProviderClient(client(async () => {
      throw new Error("must not be called");
    }));
    const result = await dispatchValidatedRequest(
      ownerId,
      identity(smallSummary()),
      { ...request(), state: "processing" },
      "What is the clicks for the file?",
    );
    assert.equal(result.state, "processing");
    assert.equal(calls.length, 0);
  });
});

async function recordResult(
  providerResult: ProviderResult,
  state: string,
): Promise<{ values: unknown[] }> {
  calls.length = 0;
  installDatabase([
    [{ authorized: true, provider: "openai", model: MIA_MODEL }],
    [],
    [stored(state, null, null)],
  ]);
  // The provider test double is not a React hook.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  useMiaProviderClient(client(async () => providerResult));
  await dispatchValidatedRequest(
    ownerId,
    identity(smallSummary()),
    request(),
    "What is the clicks for the file?",
  );
  const recorded = calls.find((call) => call.text.includes("record_mia_attempt_outcome"));
  assert.ok(recorded);
  return recorded;
}

function httpResult(status: number, body: string, requestId: string | null): Response {
  const headers = new Headers();
  if (requestId !== null) {
    headers.set("x-request-id", requestId);
  }
  return new Response(body, { status, headers });
}

function completedBody(): string {
  return JSON.stringify({
    status: "completed",
    output: [{
      type: "message",
      content: [{ type: "output_text", text: "{\"facts\":[],\"comparisons\":[]}" }],
    }],
    usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 0 } },
  });
}

function client(respond: MiaProviderClient["respond"]): MiaProviderClient {
  return { respond };
}

function installDatabase(queue: unknown[][]): void {
  const responses = [...queue];
  replaceMiaDatabase(() => async (strings, ...values) => {
    calls.push({ text: strings.join(" "), values: [...values] });
    return responses.shift() ?? [];
  });
}

function request(): MiaRequestRecord {
  return {
    requestId: "33333333-3333-4333-8333-333333333333",
    requestType: "evidence_question",
    state: "validating",
    resultCode: "created",
    availability: "awaiting_provider",
    renderedText: null,
    failureCategory: null,
    createdAt: null,
    completedAt: null,
  };
}

function stored(state: string, renderedText: string | null, failureCategory: string | null) {
  return {
    request_id: "33333333-3333-4333-8333-333333333333",
    request_type: "evidence_question",
    state,
    rendered_text: renderedText,
    failure_category: failureCategory,
    created_at: null,
    completed_at: null,
  };
}

function identity(summary: EvidenceSummary) {
  return {
    id: evidenceId,
    parserVersion: PARSER_VERSION,
    calculationVersion: CALCULATION_VERSION,
    summary,
  };
}

function smallSummary(): EvidenceSummary {
  return {
    calculationVersion: CALCULATION_VERSION,
    parserVersion: PARSER_VERSION,
    currencySource: "upload",
    period: { start: "2024-02-01", end: "2024-02-01" },
    impressions: "10",
    clicks: "2",
    ctr: { kind: "omitted", reason: "not_exact" },
    currencies: [],
    channels: [],
    campaigns: [],
  };
}
