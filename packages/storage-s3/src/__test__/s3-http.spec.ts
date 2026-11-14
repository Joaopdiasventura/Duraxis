import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { afterEach, expect, it } from "vitest";
import { S3StorageDriver } from "../index.js";

// Exercises the actual SDK middleware/HTTP stack against loopback, never AWS.
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

it("sends real conditional headers, never retries lost mutations, and retries only reads", async () => {
  const entries = new Map<string, { body: Buffer; etag: string; state: string }>();
  let puts = 0;
  let gets = 0;
  let transientReads = 0;
  let dropWriteResponse = false;
  const conditions: (string | undefined)[] = [];
  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const key = decodeURIComponent(request.url!.split("?")[0]);
    const current = entries.get(key);
    if (request.method == "PUT") {
      puts++;
      const chunks: Uint8Array[] = [];
      for await (const chunk of request) {
        if (!(chunk instanceof Uint8Array)) throw new Error("Expected HTTP bytes");
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      const etag = `"${createHash("sha256").update(body).digest("hex")}"`;
      const condition = request.headers["if-match"] ?? request.headers["if-none-match"];
      if (Array.isArray(condition)) throw new Error("Unexpected condition list");
      conditions.push(condition);
      entries.set(key, { body, etag, state: String(request.headers["x-amz-meta-duraxis-state"]) });
      if (dropWriteResponse) {
        request.socket.destroy();
        return;
      }
      response.writeHead(200, { ETag: etag });
      response.end();
      return;
    }
    if (!current) {
      response.writeHead(404);
      response.end("<Error><Code>NoSuchKey</Code></Error>");
      return;
    }
    if (request.method == "GET") {
      gets++;
      if (transientReads-- > 0) {
        response.writeHead(503);
        response.end("<Error><Code>SlowDown</Code></Error>");
        return;
      }
    }
    response.writeHead(200, {
      ETag: current.etag,
      "Content-Length": current.body.byteLength,
      "Last-Modified": new Date().toUTCString(),
      "x-amz-meta-duraxis-format": "1",
      "x-amz-meta-duraxis-state": current.state,
    });
    response.end(request.method == "HEAD" ? undefined : current.body);
  };
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => response.destroy());
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address == "string") throw new Error("Expected TCP server");
  const driver = new S3StorageDriver({
    bucket: "local-test",
    client: {
      region: "us-east-1",
      endpoint: `http://127.0.0.1:${address.port}`,
      forcePathStyle: true,
      maxAttempts: 3,
      credentials: { accessKeyId: "local-test", secretAccessKey: "local-test" },
    },
  });
  cleanups.push(async () => {
    await driver.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  const created = await driver.put("key", new Uint8Array([1]), {
    condition: { type: "if-absent" },
  });
  if (!created.success) throw new Error("Expected create");
  expect(conditions).toEqual(["*"]);
  transientReads = 2;
  expect((await driver.get("key"))?.data).toEqual(new Uint8Array([1]));
  expect(gets).toBe(3);
  dropWriteResponse = true;
  await expect(
    driver.put("key", new Uint8Array([2]), {
      condition: { type: "if-version", version: created.version },
    }),
  ).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
  expect(puts).toBe(2);
  expect(conditions).toEqual(["*", created.version]);
  expect((await driver.get("key"))?.data).toEqual(new Uint8Array([2]));
  dropWriteResponse = false;
  await driver.put("dot/../other", new Uint8Array([3]), { condition: { type: "if-absent" } });
  expect(entries.has("/local-test/dot/../other")).toBe(true);
  expect((await driver.get("dot/../other"))?.data).toEqual(new Uint8Array([3]));
});
