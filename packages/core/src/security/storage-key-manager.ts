import { randomUUID } from "node:crypto";
import { assertStorageKey } from "@duraxis/storage";

import { assertDigest, sha256 } from "../integrity/integrity.js";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class StorageKeyManager {
  public readonly namespace: string;
  public readonly manifestKey: string;
  public readonly objectPrefix: string;
  public readonly commitPrefix: string;

  private readonly objectPattern: RegExp;
  private readonly commitPattern: RegExp;

  public constructor(namespace = "__duraxis/v1") {
    if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(namespace))
      throw new Error("Invalid Duraxis storage namespace");

    this.namespace = namespace;
    this.manifestKey = `${namespace}/manifest`;
    this.objectPrefix = `${namespace}/objects/`;
    this.commitPrefix = `${namespace}/commits/`;

    this.objectPattern = new RegExp(
      `^${escapeRegex(this.objectPrefix)}(${UUID})(?:-([a-f0-9]{64}))?$`,
    );

    this.commitPattern = new RegExp(`^${escapeRegex(this.commitPrefix)}(${UUID})-([a-f0-9]{64})$`);
  }

  public validateLogicalKey(key: string): void {
    assertStorageKey(key);

    if (key == "__duraxis" || key.startsWith("__duraxis/"))
      throw new Error("Reserved Duraxis logical key namespace");
  }

  public objectKey(data: Uint8Array): string {
    return `${this.objectPrefix}` + `${randomUUID()}-${sha256(data)}`;
  }

  public commitKey(id: string, data: Uint8Array): string {
    if (!new RegExp(`^${UUID}$`).test(id)) throw new Error("Invalid transaction ID");
    return `${this.commitPrefix}` + `${id}-${sha256(data)}`;
  }

  public validateObjectKey(key: string): void {
    if (!this.objectPattern.test(key))
      throw new Error("Invalid or foreign Duraxis object reference");
  }

  public validateCommitKey(key: string): void {
    if (!this.commitPattern.test(key))
      throw new Error("Invalid or foreign Duraxis commit reference");
  }

  public verifyObject(key: string, data: Uint8Array): void {
    const match = this.objectPattern.exec(key);

    if (!match) throw new Error("Invalid or foreign Duraxis object reference");

    if (match[2])
      try {
        assertDigest(data, match[2]);
      } catch {
        throw new Error(`Duraxis object integrity check failed: ${key}`);
      }
  }

  public verifyCommit(key: string, data: Uint8Array): void {
    const match = this.commitPattern.exec(key);

    if (!match) throw new Error("Invalid or foreign Duraxis commit reference");

    assertDigest(data, match[2]);
  }
}
