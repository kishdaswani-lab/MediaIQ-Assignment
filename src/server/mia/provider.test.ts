import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { calculateEvidence } from "@/server/evidence/calculate-evidence";
import { parseCampaignCsv } from "@/server/evidence/parse-campaign-csv";
import { CALCULATION_VERSION, PARSER_VERSION, type EvidenceSummary } from "@/server/evidence/types";
import { buildEvidencePacket } from "./engine";
import {
  MIA_INPUT_FRAMING_UNCERTAINTY,
  MIA_MAX_INPUT_TOKENS,
  MIA_MODEL,
  MIA_TIMEOUT_MS,
  assessMiaInput,
  inputLimitMessage,
  executeProviderRequest,
  miaModelRequest,
  providerFailureCategory,
  providerRefusalMessage,
  readProviderResponse,
  useMiaProviderClient,
  type MiaProviderClient,
} from "./provider";
import { dispatchValidatedRequest, replaceMiaDatabase, type MiaRequestRecord } from "./service";

const miaRoot = path.dirname(fileURLToPath(import.meta.url));
const evidenceId = "11111111-1111-4111-8111-111111111111";
const ownerId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const calls: { text: string; values: unknown[] }[] = [];
const responses: unknown[][] = [];

afterEach(() => {
  calls.length = 0;
  responses.length = 0;
  useMiaProviderClient(null);
  replaceMiaDatabase();
});

describe("MIA provider adapter", () => {
  it("sends the two-campaign sample with every available reference", () => {
    const packet = buildEvidencePacket(evidenceId, sampleSummary());
    const question = "What is the click-through rate for the file?";
    const assessment = assessMiaInput(packet, question);
    const body = miaModelRequest(packet, question);
    assert.equal(typeof body, "string");
    assert.equal(assessment.withinCeiling, true);
    assert.ok(assessment.instructions > 0);
    assert.equal(assessment.question, Buffer.byteLength(question));
    assert.ok(assessment.evidence > 0);
    assert.ok(assessment.envelope > 0);
    assert.equal(assessment.framingUncertainty, MIA_INPUT_FRAMING_UNCERTAINTY);
    assert.ok(assessment.body + assessment.framingUncertainty <= MIA_MAX_INPUT_TOKENS);
    const request = JSON.parse(body ?? "") as {
      store?: boolean;
      model?: string;
      input?: string;
      text?: { format?: { strict?: boolean; schema?: { required?: string[] } } };
    };
    assert.equal(request.store, false);
    assert.equal(request.model, MIA_MODEL);
    assert.equal(request.text?.format?.strict, true);
    assert.deepEqual(request.text?.format?.schema?.required, ["facts", "comparisons"]);
    const input = request.input ?? "";
    const referenceLines = input.split("\n").filter((line) => /^[a-z_]+\t(file|channel|campaign)\t/.test(line));
    assert.equal(referenceLines.length, packet.available.length);
    for (const fact of packet.available) {
      const reference = fact.reference;
      assert.equal(referenceLines.includes([
        reference.metricId,
        reference.dimension,
        reference.dimensionValue,
        reference.unit,
      ].join("\t")), true);
    }
    assert.match(input, /channels\tGoogle\tMeta/);
    assert.match(input, /campaigns\tSpring/);
    assert.equal(input.includes("32.50"), false);
    assert.equal(input.includes("date,campaign,channel,spend"), false);
    assert.equal(JSON.stringify(packet).includes("source_text"), false);
    assert.equal(miaModelRequest(buildEvidencePacket(evidenceId, oversizedSummary()), question), null);

    const providerSource = fs.readFileSync(path.join(miaRoot, "provider.ts"), "utf8");
    const serviceSource = fs.readFileSync(path.join(miaRoot, "service.ts"), "utf8");
    assert.equal(providerSource.includes("console."), false);
    assert.equal(serviceSource.includes("console."), false);
    assert.match(providerSource, /MEDIAIQ_OPENAI_API_KEY/);
    assert.equal(providerSource.includes("NEXT_PUBLIC_"), false);
    assert.equal(providerSource.includes("source_text"), false);
  });

  it("persists an oversized request without a provider call or a reservation", async () => {
    installDatabase([
      [{ result_code: "failed" }],
      [{
        request_id: "33333333-3333-4333-8333-333333333333",
        request_type: "evidence_question",
        state: "failed",
        rendered_text: null,
        failure_category: inputLimitMessage,
        created_at: null,
        completed_at: new Date("2024-03-02T00:00:00.000Z"),
      }],
    ]);
    let called = 0;
    useMiaProviderClient(client(() => {
      called += 1;
      throw new Error("provider was called");
    }));
    const campaignName = `Campaign ${"x".repeat(2500)}`;
    const oversized = {
      ...smallSummary(),
      campaigns: [{
        name: campaignName,
        impressions: "1",
        clicks: "1",
        ctr: { kind: "omitted" as const, reason: "not_exact" as const },
        currencies: [{
          currency: "USD",
          spend: "10.00",
          cpc: { kind: "omitted" as const, reason: "not_exact" as const },
        }],
      }],
    };
    const question = `What is the spend for ${campaignName}?`;
    const result = await dispatchValidatedRequest(
      ownerId,
      identity(oversized),
      request(),
      question,
    );
    assert.equal(called, 0);
    assert.equal(result.state, "failed");
    assert.equal(result.renderedText, null);
    assert.equal(result.failureCategory, inputLimitMessage);
    assert.match(joined(), /fail_mia_request_before_dispatch/);
    assert.equal(joined().includes("claim_mia_dispatch"), false);
    assert.equal(joined().includes("record_mia_attempt_outcome"), false);

    calls.length = 0;
    const replay = await dispatchValidatedRequest(
      ownerId,
      identity(oversized),
      { ...request(), state: "failed", failureCategory: inputLimitMessage },
      question,
    );
    assert.equal(called, 0);
    assert.equal(calls.length, 0);
    assert.equal(replay.state, "failed");
  });

  it("does not call the provider when the claim is not authorized", async () => {
    installDatabase([[{ authorized: false, provider: null, model: null }]]);
    let called = false;
    useMiaProviderClient(client(() => {
      called = true;
      throw new Error("provider was called");
    }));
    const result = await dispatchValidatedRequest(ownerId, identity(smallSummary()), request(), "What is the clicks for the file?");
    assert.equal(called, false);
    assert.equal(result.state, "validating");
    assert.equal(calls.some((call) => call.text.includes("record_mia_attempt_outcome")), false);
  });

  it("records an unapproved model without a provider call", async () => {
    installDatabase([
      [{ authorized: true, provider: "other", model: "other-model" }],
      [],
      [stored("failed", null)],
    ]);
    let called = false;
    useMiaProviderClient(client(() => {
      called = true;
      throw new Error("provider was called");
    }));
    const result = await dispatchValidatedRequest(ownerId, identity(smallSummary()), request(), "What is the clicks for the file?");
    assert.equal(called, false);
    assert.equal(result.state, "failed");
    assert.match(joined(), /non_billable/);
    assert.equal(joined().includes("other-model"), false);
  });

  it("renders the server sentence and drops a fabricated amount", async () => {
    const evidence = smallSummary();
    const packet = buildEvidencePacket(evidenceId, evidence);
    const reference = packet.available.find((fact) => fact.reference.metricId === "clicks" && fact.reference.dimension === "file");
    installDatabase([
      [{ authorized: true, provider: "openai", model: MIA_MODEL }],
      [],
      [stored("completed", "CPC for Meta in USD was $0.07 USD.")],
    ]);
    useMiaProviderClient(client(async () => ({
      disposition: "completed",
      output: { facts: [{ ...reference?.reference, amount: "999999" }], comparisons: [] },
      usage: { inputTokens: 20, cachedInputTokens: 0, outputTokens: 8, otherBillableTokens: null },
      latencyMs: 12,
    })));
    const result = await dispatchValidatedRequest(ownerId, identity(evidence), request(), "What is the clicks for the file?");
    assert.equal(result.renderedText, "CPC for Meta in USD was $0.07 USD.");
    assert.equal(joined().includes("999999"), false);
    assert.match(joined(), /"inputTokens"|20/);
  });

  it("keeps a timeout ambiguous and does not store provider text", async () => {
    installDatabase([
      [{ authorized: true, provider: "openai", model: MIA_MODEL }],
      [],
      [stored("timed_out", null)],
    ]);
    useMiaProviderClient(client(async () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    }));
    const result = await dispatchValidatedRequest(ownerId, identity(smallSummary()), request(), "What is the clicks for the file?");
    assert.equal(result.state, "timed_out");
    assert.equal(result.renderedText, null);
    assert.match(joined(), /timed_out/);
    assert.match(joined(), /unknown/);
    assert.equal(joined().includes("aborted"), false);
    assert.equal(MIA_TIMEOUT_MS, 30000);
  });

  it("reads token usage without keeping the raw response body", () => {
    const parsed = readProviderResponse({
      status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "{\"facts\":[],\"comparisons\":[]}" }] }],
      usage: { input_tokens: 11, output_tokens: 4, input_tokens_details: { cached_tokens: 2 } },
    });
    assert.equal(parsed?.disposition, "completed");
    assert.equal(parsed?.usage.inputTokens, 11);
    assert.equal(parsed?.usage.cachedInputTokens, 2);
    assert.equal(parsed?.usage.outputTokens, 4);
    const extra = readProviderResponse({
      status: "completed",
      output: [{ content: [{ text: "{\"facts\":[],\"comparisons\":[]}" }] }],
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 15 },
    });
    assert.equal(extra?.usage.otherBillableTokens, 3);
  });

  it("refuses invalid structured output instead of showing model prose", async () => {
    installDatabase([
      [{ authorized: true, provider: "openai", model: MIA_MODEL }],
      [],
      [stored("refused", "That response could not be checked against the saved evidence.")],
    ]);
    useMiaProviderClient(client(async () => ({
      disposition: "completed",
      output: { facts: "not-a-list", prose: "Spend is 999999." },
      usage: { inputTokens: 12, cachedInputTokens: 0, outputTokens: 4, otherBillableTokens: null },
      latencyMs: 9,
    })));
    const result = await dispatchValidatedRequest(ownerId, identity(smallSummary()), request(), "What is the clicks for the file?");
    assert.equal(result.state, "refused");
    assert.equal(result.renderedText, "That response could not be checked against the saved evidence.");
    assert.equal(joined().includes("999999"), false);
    assert.equal(joined().includes("not-a-list"), false);
  });

  it("builds a summary document from resolved references", async () => {
    const evidence = smallSummary();
    const packet = buildEvidencePacket(evidenceId, evidence);
    const reference = packet.available.find((fact) => fact.reference.metricId === "clicks" && fact.reference.dimension === "file");
    const document = "{\"contextVersion\":\"mia-panel-1\"}";
    installDatabase([
      [{ authorized: true, provider: "openai", model: MIA_MODEL }],
      [],
      [{ ...stored("completed", document), request_type: "performance_summary" }],
    ]);
    useMiaProviderClient(client(async () => ({
      disposition: "completed",
      output: { facts: [{ ...reference?.reference, amount: "999999" }], comparisons: [] },
      usage: { inputTokens: 18, cachedInputTokens: 1, outputTokens: 6, otherBillableTokens: null },
      latencyMs: 15,
    })));
    const summaryRequest = request();
    summaryRequest.requestType = "performance_summary";
    const result = await dispatchValidatedRequest(ownerId, identity(evidence), summaryRequest, null);
    assert.equal(result.state, "completed");
    assert.match(joined(), /mia-panel-1/);
    assert.equal(joined().includes("999999"), false);
  });

  it("retains an unpriced result instead of recording a guessed cost", async () => {
    installDatabase([
      [{ authorized: true, provider: "openai", model: MIA_MODEL }],
      [],
      [stored("reconciliation_required", null)],
    ]);
    useMiaProviderClient(client(async () => ({
      disposition: "completed",
      output: { facts: [], comparisons: [] },
      usage: { inputTokens: null, cachedInputTokens: null, outputTokens: null, otherBillableTokens: 3 },
      latencyMs: 4,
    })));
    const result = await dispatchValidatedRequest(ownerId, identity(smallSummary()), request(), "What is the clicks for the file?");
    assert.equal(result.state, "reconciliation_required");
    assert.equal(result.renderedText, null);
    const recorded = calls.find((call) => call.text.includes("record_mia_attempt_outcome"));
    assert.ok(recorded);
    assert.equal(recorded.values[4], "unknown");
    assert.equal(recorded.values[5], null);
    assert.equal(recorded.values[6], null);
    assert.equal(recorded.values[7], 3);
    assert.equal(recorded.values[9], null);
    assert.equal(recorded.values[16], null);
    assert.equal(recorded.values.includes(0), false);
  });

  it("accepts only a completed structured response", async () => {
    const evidence = smallSummary();
    const reference = buildEvidencePacket(evidenceId, evidence).available.find((fact) => fact.reference.metricId === "clicks" && fact.reference.dimension === "file");
    installDatabase([
      [{ authorized: true, provider: "openai", model: MIA_MODEL }],
      [],
      [stored("completed", "Clicks for the file was 2.")],
    ]);
    useMiaProviderClient(client(async () => ({
      disposition: "completed",
      output: { facts: [reference?.reference], comparisons: [] },
      usage: reliableUsage(),
      latencyMs: 8,
    })));
    const result = await dispatchValidatedRequest(ownerId, identity(evidence), request(), "What is the clicks for the file?");
    assert.equal(result.state, "completed");
    const recorded = recordCall();
    assert.equal(recorded.values[3], "completed");
    assert.equal(recorded.values[4], "reported");
    assert.equal(recorded.values[5], 20);
    assert.equal(recorded.values[16], 0);
  });

  it("keeps a provider refusal out of the evidence answer and can settle its usage", async () => {
    const parsed = readProviderResponse({
      status: "completed",
      output: [{
        type: "message",
        content: [
          { type: "refusal", refusal: "REFUSAL-PROSE" },
          { type: "output_text", text: "{\"facts\":[{\"metricId\":\"spend\"}],\"comparisons\":[]}" },
        ],
      }],
      usage: { input_tokens: 20, output_tokens: 4, input_tokens_details: { cached_tokens: 0 } },
    });
    assert.equal(parsed?.disposition, "refused");
    assert.equal(parsed?.output, null);
    installDatabase([
      [{ authorized: true, provider: "openai", model: MIA_MODEL }],
      [],
      [stored("refused", providerRefusalMessage)],
    ]);
    useMiaProviderClient(client(async () => ({
      disposition: "refused",
      output: null,
      usage: reliableUsage(),
      latencyMs: 6,
    })));
    const result = await dispatchValidatedRequest(ownerId, identity(smallSummary()), request(), "What is the clicks for the file?");
    assert.equal(result.state, "refused");
    assert.equal(result.renderedText, providerRefusalMessage);
    const recorded = recordCall();
    assert.equal(recorded.values[3], "refused");
    assert.equal(recorded.values[4], "reported");
    assert.equal(recorded.values[11], providerRefusalMessage);
    assert.equal(recorded.values[13], providerFailureCategory.refusal);
    assert.equal(recorded.values[14], null);
    assert.equal(recorded.values[15], null);
    assert.equal(joined().includes("REFUSAL-PROSE"), false);
  });

  it("does not accept incomplete or failed output, and settles only reliable usage", async () => {
    const incompleteJson = readProviderResponse({
      status: "incomplete",
      output: [{ content: [{ type: "output_text", text: "{\"facts\":[],\"comparisons\":[],\"note\":\"INCOMPLETE-JSON\"}" }] }],
      usage: { input_tokens: 20, output_tokens: 4, input_tokens_details: { cached_tokens: 0 } },
    });
    assert.equal(incompleteJson?.disposition, "incomplete");
    assert.equal(incompleteJson?.output, null);
    const incompleteEmpty = readProviderResponse({ status: "incomplete", output: [] });
    assert.equal(incompleteEmpty?.disposition, "incomplete");
    assert.equal(incompleteEmpty?.usage.inputTokens, null);
    const failedJson = readProviderResponse({
      status: "failed",
      output: [{ content: [{ text: "{\"facts\":[],\"comparisons\":[],\"note\":\"FAILED-JSON\"}" }] }],
      usage: { input_tokens: 9, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } },
    });
    assert.equal(failedJson?.disposition, "failed");
    assert.equal(failedJson?.output, null);
    const failedEmpty = readProviderResponse({ status: "failed" });
    assert.equal(failedEmpty?.disposition, "failed");
    assert.equal(failedEmpty?.usage.outputTokens, null);

    await recordUnsuccessful("incomplete", reliableUsage(), "reported", providerFailureCategory.incomplete);
    assert.equal(joined().includes("INCOMPLETE-JSON"), false);
    calls.length = 0;
    responses.length = 0;
    await recordUnsuccessful("incomplete", { inputTokens: null, cachedInputTokens: null, outputTokens: null, otherBillableTokens: null }, "unknown", providerFailureCategory.incomplete);
    calls.length = 0;
    responses.length = 0;
    await recordUnsuccessful("failed", reliableUsage(), "reported", providerFailureCategory.failed);
    calls.length = 0;
    responses.length = 0;
    await recordUnsuccessful("failed", { inputTokens: null, cachedInputTokens: null, outputTokens: null, otherBillableTokens: null }, "unknown", providerFailureCategory.failed);
    const uncertain = recordCall();
    assert.equal(uncertain.values[9], null);
    assert.equal(uncertain.values[14], null);
    assert.equal(uncertain.values[15], null);
  });

  it("treats a missing or unknown status as unverified", () => {
    const missing = readProviderResponse({
      output: [{ content: [{ text: "{\"facts\":[],\"comparisons\":[]}" }] }],
      usage: { input_tokens: 3, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } },
    });
    assert.equal(missing?.disposition, "unverified");
    assert.equal(missing?.output, null);
    assert.equal(missing?.usage.inputTokens, 3);
    const unknown = readProviderResponse({ status: "cancelled", output: [{ type: "message", content: [{ type: "output_text", text: "{\"facts\":[]}" }] }] });
    assert.equal(unknown?.disposition, "unverified");
    assert.equal(unknown?.output, null);
    assert.equal(readProviderResponse(["not-an-object"]), null);
    assert.equal(readProviderResponse("payload"), null);
  });

  it("does not retry a non-200 response, a transport failure, or a malformed body", async () => {
    let callsToFetch = 0;
    const fetchImpl: typeof fetch = async () => {
      callsToFetch += 1;
      return new Response("secret body", { status: 503 });
    };
    const rejected = await executeProviderRequest("local-test-key", "{}", 1000, fetchImpl);
    assert.equal(callsToFetch, 1);
    assert.equal(rejected.transport?.outcome, "http_rejected");
    assert.equal(rejected.transport?.httpStatus, 503);
    assert.equal(JSON.stringify(rejected).includes("secret body"), false);

    callsToFetch = 0;
    const network: typeof fetch = async () => {
      callsToFetch += 1;
      throw new TypeError("network down");
    };
    const unreachable = await executeProviderRequest("local-test-key", "{}", 1000, network);
    assert.equal(callsToFetch, 1);
    assert.equal(unreachable.transport?.outcome, "network");
    assert.equal(JSON.stringify(unreachable).includes("network down"), false);

    const malformed: typeof fetch = async () => new Response("not-json", { status: 200, headers: { "content-type": "application/json" } });
    const malformedResult = await executeProviderRequest("local-test-key", "{}", 1000, malformed);
    assert.equal(malformedResult.transport?.outcome, "malformed_response");
    assert.equal(JSON.stringify(malformedResult).includes("not-json"), false);
    const unexpected: typeof fetch = async () => Response.json(["not-an-object"]);
    const unexpectedResult = await executeProviderRequest("local-test-key", "{}", 1000, unexpected);
    assert.equal(unexpectedResult.transport?.outcome, "malformed_response");
    const hanging: typeof fetch = (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    });
    const timedOut = await executeProviderRequest("local-test-key", "{}", 20, hanging);
    assert.equal(timedOut.transport?.outcome, "timeout");
    assert.equal(timedOut.transport?.httpResponseReceived, false);

    installDatabase([
      [{ authorized: true, provider: "openai", model: MIA_MODEL }],
      [],
      [stored("failed", null)],
    ]);
    useMiaProviderClient(client(async () => {
      throw new TypeError("network down");
    }));
    const result = await dispatchValidatedRequest(ownerId, identity(smallSummary()), request(), "What is the clicks for the file?");
    assert.equal(result.state, "failed");
    const recorded = recordCall();
    assert.equal(recorded.values[3], "failed");
    assert.equal(recorded.values[4], "unknown");
    assert.equal(recorded.values[5], null);
    assert.equal(recorded.values[9], null);
    assert.equal(recorded.values[11], null);
    assert.equal(joined().includes("network down"), false);
  });
});

function reliableUsage() {
  return { inputTokens: 20, cachedInputTokens: 0, outputTokens: 4, otherBillableTokens: null };
}

async function recordUnsuccessful(
  disposition: "incomplete" | "failed",
  usage: { inputTokens: number | null; cachedInputTokens: number | null; outputTokens: number | null; otherBillableTokens: number | null },
  billing: "reported" | "unknown",
  category: string,
): Promise<void> {
  installDatabase([
    [{ authorized: true, provider: "openai", model: MIA_MODEL }],
    [],
    [stored("failed", null)],
  ]);
  // The provider test double is not a React hook.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  useMiaProviderClient(client(async () => ({
    disposition,
    output: { facts: [{ note: "INCOMPLETE-JSON" }], comparisons: [] },
    usage,
    latencyMs: 3,
  })));
  const result = await dispatchValidatedRequest(ownerId, identity(smallSummary()), request(), "What is the clicks for the file?");
  assert.equal(result.state, "failed");
  assert.equal(result.renderedText, null);
  const recorded = recordCall();
  assert.equal(recorded.values[3], "failed");
  assert.equal(recorded.values[4], billing);
  assert.equal(recorded.values[13], category);
  assert.equal(recorded.values[14], null);
  assert.equal(recorded.values[15], null);
  assert.notEqual(recorded.values[3], "completed");
}

function recordCall(): { text: string; values: unknown[] } {
  const recorded = calls.find((call) => call.text.includes("record_mia_attempt_outcome"));
  assert.ok(recorded);
  return recorded;
}

function client(respond: MiaProviderClient["respond"]): MiaProviderClient {
  return { respond };
}

function installDatabase(queue: unknown[][]): void {
  responses.push(...queue);
  replaceMiaDatabase(() => async (strings, ...values) => {
    calls.push({ text: strings.join(" "), values: [...values] });
    return responses.shift() ?? [];
  });
}

function joined(): string {
  return calls.map((call) => `${call.text} ${JSON.stringify(call.values)}`).join("\n");
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

function stored(state: string, renderedText: string | null) {
  return {
    request_id: "33333333-3333-4333-8333-333333333333",
    request_type: "evidence_question",
    state,
    rendered_text: renderedText,
    failure_category: null,
    created_at: new Date("2024-03-02T00:00:00.000Z"),
    completed_at: null,
  };
}

function identity(summaryValue: EvidenceSummary) {
  return {
    id: evidenceId,
    parserVersion: PARSER_VERSION,
    calculationVersion: CALCULATION_VERSION,
    summary: summaryValue,
  };
}

function oversizedSummary(): EvidenceSummary {
  return {
    ...smallSummary(),
    campaigns: Array.from({ length: 400 }, (_, index) => ({
      name: `Campaign ${index} ${"x".repeat(40)}`,
      impressions: "1",
      clicks: "1",
      ctr: { kind: "omitted", reason: "not_exact" },
      currencies: [],
    })),
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

function sampleSummary(): EvidenceSummary {
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
