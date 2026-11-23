import assert from "node:assert/strict";
import test from "node:test";
import {
  authContextFromClaims,
  canonicalAuditPayload,
  canonicalJson,
  signAuditPayload,
} from "./audit-signature.ts";

const vectorPayload = [
  "mediaiq-audit-v1",
  "1",
  "11111111-1111-4111-8111-111111111111",
  "login_succeeded",
  "88888888-8888-4888-8888-888888888888",
  "1763510400123000",
  '{"method":"password"}',
  '{"aal":"aal1","method":"password","session_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"}',
].join("\n");

test("canonical audit payload matches the eight-line vector", () => {
  const payload = canonicalAuditPayload({
    keyId: 1,
    eventId: "11111111-1111-4111-8111-111111111111",
    operation: "login_succeeded",
    actorId: "88888888-8888-4888-8888-888888888888",
    issuedMicros: BigInt("1763510400123000"),
    metadata: { method: "password" },
    context: {
      session_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      aal: "aal1",
      method: "password",
    },
  });

  assert.equal(payload, vectorPayload);
  assert.equal(Buffer.byteLength(payload, "utf8"), 234);
  assert.equal(payload.endsWith("\n"), false);
  assert.equal(
    signAuditPayload(payload, "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff"),
    "60774719ade831f4b25c9c8ad24f3f737248f678b19ff3e26b805c13b4cc9e2f",
  );
});

test("canonical JSON keeps the supplied escaping vector", () => {
  const encoded = canonicalJson({ b: "é", a: 'x"y' });

  assert.equal(encoded, '{"a":"x\\"y","b":"é"}');
  assert.equal(
    Buffer.from(encoded, "utf8").toString("hex"),
    "7b2261223a22785c2279222c2262223a22c3a9227d",
  );
  assert.equal(canonicalJson({ line: "a\nb" }), '{"line":"a\\u000ab"}');
  assert.equal(canonicalJson({ mark: "\u2028" }), '{"mark":"\u2028"}');
});

test("authentication context comes from allowlisted verified claims", () => {
  const verified = authContextFromClaims({
    sub: "88888888-8888-4888-8888-888888888888",
    aal: "aal2",
    session_id: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
    amr: [
      { method: "password", timestamp: 10 },
      { method: "totp", timestamp: 10 },
      { method: "password", timestamp: 11 },
    ],
  });

  assert.deepEqual(verified, {
    actorId: "88888888-8888-4888-8888-888888888888",
    context: {
      aal: "aal2",
      method: "password",
      session_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    },
  });
  assert.equal(
    authContextFromClaims({
      sub: "88888888-8888-4888-8888-888888888888",
      aal: "aal1",
      session_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      amr: ["otp", "password"],
    })?.context.method,
    "password",
  );
  assert.equal(
    authContextFromClaims({
      sub: "88888888-8888-4888-8888-888888888888",
      aal: "aal1",
      session_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      amr: [{ method: "oauth", timestamp: 10 }],
    }),
    null,
  );
  assert.equal(
    authContextFromClaims({
      aal: "aal1",
      session_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      amr: ["password"],
    }),
    null,
  );
});

test("email confirmation can start enrollment and totp becomes the newer method", () => {
  const enrollment = authContextFromClaims({
    sub: "88888888-8888-4888-8888-888888888888",
    aal: "aal1",
    session_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    amr: [{ method: "email/signup", timestamp: 10 }],
  });

  assert.equal(enrollment?.context.aal, "aal1");
  assert.equal(enrollment?.context.method, "email/signup");

  const verified = authContextFromClaims({
    sub: "88888888-8888-4888-8888-888888888888",
    aal: "aal2",
    session_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    amr: [
      { method: "email/signup", timestamp: 10 },
      { method: "totp", timestamp: 20 },
    ],
  });

  assert.deepEqual(verified?.context, {
    aal: "aal2",
    method: "totp",
    session_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  });
  assert.equal(
    authContextFromClaims({
      sub: "88888888-8888-4888-8888-888888888888",
      aal: "aal2",
      session_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      amr: [{ method: "email/signup", timestamp: 30 }],
    }),
    null,
  );
  assert.equal(
    authContextFromClaims({
      sub: "88888888-8888-4888-8888-888888888888",
      aal: "aal1",
      session_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      amr: [{ method: "oauth", timestamp: 10 }],
    }),
    null,
  );
});
