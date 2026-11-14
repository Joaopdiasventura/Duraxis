import { randomUUID } from "node:crypto";
import { DeleteObjectCommand, ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";
import { defineStorageConformanceSuite } from "@duraxis/storage-testkit";
import { afterAll, describe } from "vitest";
import { S3StorageDriver, type S3StorageDriverOptions } from "../index.js";
import { defineDatabaseScenarios } from "./database-scenarios.js";

const enabled = process.env.DURAXIS_S3_INTEGRATION == "1";
const bucket = process.env.DURAXIS_S3_TEST_BUCKET;
if (enabled && !bucket)
  throw new Error("DURAXIS_S3_TEST_BUCKET is required for live integration tests");

describe.skipIf(!enabled)("explicitly configured live S3 integration", () => {
  const root = `duraxis-integration/${randomUUID()}/`;
  const options: S3StorageDriverOptions = {
    bucket: bucket ?? "not-configured",
    client: {
      region: process.env.DURAXIS_S3_TEST_REGION ?? "us-east-1",
      ...(process.env.DURAXIS_S3_TEST_ENDPOINT
        ? { endpoint: process.env.DURAXIS_S3_TEST_ENDPOINT }
        : {}),
      forcePathStyle: process.env.DURAXIS_S3_TEST_PATH_STYLE == "1",
    },
  };
  const drivers: S3StorageDriver[] = [];
  const create = (prefix: string) => {
    const driver = new S3StorageDriver({ ...options, prefix });
    drivers.push(driver);
    return driver;
  };
  defineStorageConformanceSuite({
    name: "live S3",
    createDriver: () => create(`${root}${randomUUID()}`),
  });
  defineDatabaseScenarios(() => {
    const prefix = `${root}${randomUUID()}`;
    return () => create(prefix);
  });
  afterAll(async () => {
    await Promise.all(drivers.map(async (driver) => await driver.close()));
    const client = new S3Client({ ...options.client, maxAttempts: 1 });
    try {
      // Only this run's random namespace is eligible for cleanup. No bucket-wide deletion.
      const objects: { key: string; etag: string }[] = [];
      let token: string | undefined;
      do {
        const page = await client.send(
          new ListObjectsV2Command({
            Bucket: options.bucket,
            Prefix: root,
            ContinuationToken: token,
          }),
        );
        for (const item of page.Contents ?? []) {
          if (!item.Key?.startsWith(root) || !item.ETag)
            throw new Error("Unexpected integration cleanup entry");
          objects.push({ key: item.Key, etag: item.ETag });
        }
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
      for (const object of objects)
        await client.send(
          new DeleteObjectCommand({
            Bucket: options.bucket,
            Key: object.key,
            IfMatch: object.etag,
          }),
        );
    } finally {
      client.destroy();
    }
  }, 120_000);
});
