import { randomUUID, createHash } from "node:crypto";
import { assertStorageKey } from "@duraxis/storage";

const DEFAULT_NAMESPACE = "__duraxis/v1";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

export class StorageKeyManager {
  public readonly namespace: string;
  public readonly manifestKey: string;

  private readonly objectPrefix: string;
  private readonly objectPattern: RegExp;

  public constructor(namespace: string = DEFAULT_NAMESPACE) {
    if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(namespace))
      throw new Error("Invalid Duraxis storage namespace");

    this.namespace = namespace;
    this.manifestKey = `${namespace}/manifest`;
    this.objectPrefix = `${namespace}/objects/`;

    this.objectPattern = new RegExp(
      `^${escapeRegex(this.objectPrefix)}(${UUID})(?:-([a-f0-9]{64}))?$`,
    );
  }

  public validateLogicalKey(key: string): void {
    assertStorageKey(key);

    if (key == "__duraxis" || key.startsWith("__duraxis/"))
      throw new Error("Reserved Duraxis logical key namespace");
  }

  public objectKey(data: Uint8Array): string {
    return `${this.objectPrefix}` + `${randomUUID()}-${this.hash(data)}`;
  }

  public validateObjectKey(key: string): void {
    if (!this.objectPattern.test(key))
      throw new Error("Invalid or foreign Duraxis object reference");
  }

  public verifyObject(key: string, data: Uint8Array): void {
    const match = this.objectPattern.exec(key);

    if (!match) throw new Error("Invalid or foreign Duraxis object reference");

    const expectedDigest = match[2];

    if (expectedDigest && this.hash(data) != expectedDigest)
      throw new Error(`Duraxis object integrity check failed: ${key}`);
  }

  private hash(data: Uint8Array): string {
    return createHash("sha256").update(data).digest("hex");
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
