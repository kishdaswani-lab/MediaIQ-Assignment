import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertEvidencePoolServer,
  evidencePoolGlobalKey,
  evidenceSql,
} from "./pool";

const evidenceDirectory = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(evidenceDirectory, "../..");
const poolSource = fs.readFileSync(new URL("./pool.ts", import.meta.url), "utf8");
const writerSource = fs.readFileSync(
  new URL("../auth/writer.ts", import.meta.url),
  "utf8",
);
const credentialUrl =
  "postgres://evidence_writer:credential@database-host.example:5432/mediaiq";

const originalConnect = net.connect;
const originalEnv = {
  nodeEnv: process.env.NODE_ENV,
  vercelEnv: process.env.VERCEL_ENV,
  evidenceUrl: process.env.MEDIAIQ_EVIDENCE_DATABASE_URL,
};
const originalConsole = {
  log: console.log,
  error: console.error,
  warn: console.warn,
  info: console.info,
};

let connectCalls = 0;
const logLines: string[] = [];

before(() => {
  net.connect = (() => {
    connectCalls += 1;
    throw new Error("database connection attempted");
  }) as typeof net.connect;
});

after(() => {
  net.connect = originalConnect;
  restoreEnv();
  restoreConsole();
});

afterEach(() => {
  restoreEnv();
  restoreConsole();
  delete globalForEvidence().mediaiqEvidenceSql;
  delete (globalThis as { window?: unknown }).window;
  logLines.length = 0;
});

describe("evidence connection pool", () => {
  it("rejects a missing evidence URL with a fixed message", () => {
    captureConsole();
    setEnv("NODE_ENV", "development");
    setEnv("VERCEL_ENV", undefined);
    setEnv("MEDIAIQ_EVIDENCE_DATABASE_URL", undefined);

    assertConfigurationError(catchError(evidenceSql), "evidence writer is not configured");
    assert.equal(connectCalls, 0);
    assert.deepEqual(logLines, []);
  });

  it("does not open a database connection when the module is imported or the client is created", () => {
    setEnv("NODE_ENV", "development");
    setEnv("VERCEL_ENV", undefined);
    setEnv("MEDIAIQ_EVIDENCE_DATABASE_URL", credentialUrl);
    captureConsole();

    const child = spawnSync(
      process.execPath,
      [
        "--conditions=react-server",
        "--experimental-strip-types",
        "--input-type=module",
        "--eval",
        [
          "import net from 'node:net';",
          "let calls = 0;",
          "net.connect = () => { calls += 1; throw new Error('database connection attempted'); };",
          "const loaded = await import('./src/server/evidence/pool.ts');",
          "loaded.evidenceSql();",
          "if (calls !== 0) throw new Error('database connection attempted');",
        ].join("\n"),
      ],
      {
        cwd: path.resolve(sourceRoot, ".."),
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_ENV: "development",
          VERCEL_ENV: "",
          MEDIAIQ_EVIDENCE_DATABASE_URL: credentialUrl,
        },
      },
    );

    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.stderr.includes("credential"), false);
    assert.equal(child.stderr.includes("database-host.example"), false);

    const client = evidenceSql();

    assert.equal(typeof client, "function");
    assert.equal(connectCalls, 0);
    assert.equal(globalForEvidence().mediaiqEvidenceSql, client);
    assert.deepEqual(logLines, []);
  });

  it("uses prepare false and the local development limits", () => {
    setEnv("NODE_ENV", "development");
    setEnv("MEDIAIQ_EVIDENCE_DATABASE_URL", credentialUrl);

    const client = evidenceSql() as unknown as EvidenceClient;

    assert.equal(client.options.prepare, false);
    assert.equal(client.options.max, 1);
    assert.equal(client.options.idle_timeout, 20);
    assert.equal(client.options.connect_timeout, 5);
    assert.equal(client.options.onnotice, false);
    assert.equal(connectCalls, 0);
  });

  it("reuses one client for the process", () => {
    setEnv("NODE_ENV", "development");
    setEnv("MEDIAIQ_EVIDENCE_DATABASE_URL", credentialUrl);

    const first = evidenceSql();
    const second = evidenceSql();

    assert.equal(first, second);
    assert.equal(connectCalls, 0);
  });

  it("keeps a global key distinct from the audit pool", () => {
    assert.equal(evidencePoolGlobalKey, "mediaiqEvidenceSql");
    assert.match(writerSource, /mediaiqSecuritySql/);
    assert.equal(poolSource.includes("mediaiqSecuritySql"), false);
    assert.equal(poolSource.includes("MEDIAIQ_SECURITY_DATABASE_URL"), false);
    assert.equal(poolSource.includes("SERVICE_ROLE"), false);
    assert.equal(poolSource.includes(evidencePoolGlobalKey), true);
  });

  it("keeps the hosted-configuration error free of the connection URL", () => {
    // No query is sent. This checks configuration errors only; query-time driver errors remain for the service stage.
    captureConsole();
    setEnv("NODE_ENV", "production");
    setEnv("MEDIAIQ_EVIDENCE_DATABASE_URL", credentialUrl);

    assertConfigurationError(
      catchError(evidenceSql),
      "evidence writer production connections are not approved",
    );
    assert.equal(globalForEvidence().mediaiqEvidenceSql, undefined);
    assert.equal(connectCalls, 0);
    assert.deepEqual(logLines, []);
  });

  it("does not add an application retry around the client", () => {
    assert.equal(poolSource.includes("backoff"), false);
    assert.equal(poolSource.includes("retry"), false);
    assert.equal((poolSource.match(/postgres\(/g) ?? []).length, 1);
  });

  it("blocks production and hosted preview initialization", () => {
    setEnv("MEDIAIQ_EVIDENCE_DATABASE_URL", credentialUrl);

    for (const env of [
      { NODE_ENV: "production", VERCEL_ENV: undefined },
      { NODE_ENV: "development", VERCEL_ENV: "production" },
      { NODE_ENV: "development", VERCEL_ENV: "preview" },
    ]) {
      delete globalForEvidence().mediaiqEvidenceSql;
      setEnv("NODE_ENV", env.NODE_ENV);
      setEnv("VERCEL_ENV", env.VERCEL_ENV);

      assert.throws(evidenceSql, {
        message: "evidence writer production connections are not approved",
      });
      assert.equal(globalForEvidence().mediaiqEvidenceSql, undefined);
    }

    assert.equal(connectCalls, 0);
  });

  it("keeps the runtime window guard", () => {
    (globalThis as { window?: unknown }).window = {};
    assertConfigurationError(catchError(assertEvidencePoolServer), "evidence writer is server only");
    delete (globalThis as { window?: unknown }).window;

    const child = spawnSync(
      process.execPath,
      [
        "--conditions=react-server",
        "--experimental-strip-types",
        "--input-type=module",
        "--eval",
        "globalThis.window = {}; await import('./src/server/evidence/pool.ts');",
      ],
      { cwd: path.resolve(sourceRoot, ".."), encoding: "utf8" },
    );

    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /evidence writer is server only/);
    assert.equal(child.stdout.includes("credential"), false);
    assert.equal(child.stderr.includes("credential"), false);
    assert.equal(child.stderr.includes("database-host.example"), false);
    assertNoClientImport();
  });

  it("rejects a pool import when the react-server condition is absent", () => {
    const child = spawnSync(
      process.execPath,
      [
        "--experimental-strip-types",
        "--input-type=module",
        "--eval",
        "await import('./src/server/evidence/pool.ts');",
      ],
      { cwd: path.resolve(sourceRoot, ".."), encoding: "utf8" },
    );

    assert.notEqual(child.status, 0);
    assert.match(
      child.stderr,
      /This module cannot be imported from a Client Component module/,
    );
    assert.equal(child.stdout.includes("credential"), false);
    assert.equal(child.stderr.includes("credential"), false);
    assert.equal(child.stderr.includes("database-host.example"), false);
  });
});

type EvidenceClient = {
  options: {
    prepare: boolean;
    max: number;
    idle_timeout: number;
    connect_timeout: number;
    onnotice: false | ((notice: unknown) => void);
  };
};

function catchError(fn: () => unknown): Error {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof Error);
    return error;
  }
  assert.fail("expected an error");
}

function assertConfigurationError(error: Error, message: string): void {
  assert.equal(error.message, message);
  assert.equal(error.message.includes("credential"), false);
  assert.equal(error.message.includes("database-host.example"), false);
  assert.equal(error.message.includes("postgres://"), false);
  assert.equal(error.cause, undefined);
}

function assertNoClientImport(): void {
  const clientFiles = walk(sourceRoot).filter((file) => {
    const text = fs.readFileSync(file, "utf8");
    return text.startsWith('"use client"') || text.startsWith("'use client'");
  });

  assert.ok(clientFiles.length > 0);
  for (const file of clientFiles) {
    const text = fs.readFileSync(file, "utf8");
    assert.equal(text.includes("server/evidence/pool"), false);
    assert.equal(text.includes("evidenceSql"), false);
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
    logLines.push(`${level}:${parts.map(String).join(" ")}`);
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

function restoreEnv(): void {
  restoreEnvValue("NODE_ENV", originalEnv.nodeEnv);
  restoreEnvValue("VERCEL_ENV", originalEnv.vercelEnv);
  restoreEnvValue("MEDIAIQ_EVIDENCE_DATABASE_URL", originalEnv.evidenceUrl);
}

function restoreEnvValue(name: string, value: string | undefined): void {
  setEnv(name, value);
}

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function globalForEvidence(): { mediaiqEvidenceSql?: unknown } {
  return globalThis as { mediaiqEvidenceSql?: unknown };
}
