import type { BPlusTreeNode, EncodedKey } from "./bptree-node.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

const MAX_NODE_BYTES = 1024 * 1024;
const MAX_KEY_BYTES = 1024;
const MAX_VALUE_BYTES = 256 * 1024;
const MAX_NODE_KEYS = 4096;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value == "object" && value != null && !Array.isArray(value);
}

export function encodeIndexKey(key: Uint8Array): EncodedKey {
  if (!(key instanceof Uint8Array) || key.length == 0 || key.length > MAX_KEY_BYTES)
    throw new Error("Invalid B+tree key");
  return Buffer.from(key).toString("hex");
}

export function decodeIndexKey(value: EncodedKey): Uint8Array {
  if (
    typeof value != "string" ||
    value.length == 0 ||
    value.length % 2 != 0 ||
    value.length > MAX_KEY_BYTES * 2 ||
    !/^[0-9a-f]+$/.test(value)
  )
    throw new Error("Invalid encoded B+tree key");

  return Uint8Array.from(Buffer.from(value, "hex"));
}

export function encodeIndexValue(value: Uint8Array): string {
  if (!(value instanceof Uint8Array) || value.length > MAX_VALUE_BYTES)
    throw new Error("Invalid B+tree value");

  return Buffer.from(value).toString("base64");
}

export function decodeIndexValue(value: string): Uint8Array {
  if (typeof value != "string" || value.length > Math.ceil(MAX_VALUE_BYTES / 3) * 4)
    throw new Error("Invalid encoded B+tree value");

  const bytes = Buffer.from(value, "base64");

  if (bytes.length > MAX_VALUE_BYTES || bytes.toString("base64") != value)
    throw new Error("Invalid encoded B+tree value");

  return Uint8Array.from(bytes);
}

export function compareKeys(left: EncodedKey, right: EncodedKey): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function lowerBound(keys: readonly EncodedKey[], key: EncodedKey): number {
  let low = 0;
  let high = keys.length;

  while (low < high) {
    const mid = low + Math.floor((high - low) / 2);

    if (compareKeys(keys[mid]!, key) < 0) low = mid + 1;
    else high = mid;
  }

  return low;
}

export function upperBound(keys: readonly EncodedKey[], key: EncodedKey): number {
  let low = 0;
  let high = keys.length;

  while (low < high) {
    const mid = low + Math.floor((high - low) / 2);

    if (compareKeys(keys[mid]!, key) <= 0) low = mid + 1;
    else high = mid;
  }

  return low;
}

export function validateNode(node: BPlusTreeNode): void {
  if (
    node.keys.length > MAX_NODE_KEYS ||
    node.keys.some((key) => {
      try {
        decodeIndexKey(key);
        return false;
      } catch {
        return true;
      }
    })
  )
    throw new Error("Invalid B+tree node keys");

  for (let index = 1; index < node.keys.length; index++)
    if (compareKeys(node.keys[index - 1]!, node.keys[index]!) >= 0)
      throw new Error("B+tree keys must be strictly increasing");

  if (node.type == "leaf") {
    if (node.keys.length != node.values.length) throw new Error("Invalid B+tree leaf value count");

    for (const value of node.values) decodeIndexValue(value);

    return;
  }

  if (node.children.length != node.keys.length + 1) throw new Error("Invalid B+tree child count");

  if (node.children.some((ref) => typeof ref != "string" || ref.length == 0))
    throw new Error("Invalid B+tree child reference");
}

export function encodeNode(node: BPlusTreeNode): Uint8Array {
  validateNode(node);

  const bytes = encoder.encode(JSON.stringify(node));

  if (bytes.length > MAX_NODE_BYTES) throw new Error("B+tree node exceeds size limit");

  return bytes;
}

export function decodeNode(bytes: Uint8Array): BPlusTreeNode {
  if (bytes.length > MAX_NODE_BYTES) throw new Error("B+tree node exceeds size limit");

  const value: unknown = JSON.parse(decoder.decode(bytes));

  if (
    !isRecord(value) ||
    !Array.isArray(value.keys) ||
    !value.keys.every((key) => typeof key == "string")
  )
    throw new Error("Invalid B+tree node");

  if (value.type == "leaf") {
    if (
      Object.keys(value).sort().join() != "keys,type,values" ||
      !Array.isArray(value.values) ||
      !value.values.every((item) => typeof item == "string")
    )
      throw new Error("Invalid B+tree leaf");

    const node: BPlusTreeNode = {
      type: "leaf",
      keys: value.keys as string[],
      values: value.values as string[],
    };

    validateNode(node);
    return node;
  }

  if (value.type == "internal") {
    if (
      Object.keys(value).sort().join() != "children,keys,type" ||
      !Array.isArray(value.children) ||
      !value.children.every((item) => typeof item == "string")
    )
      throw new Error("Invalid B+tree internal node");

    const node: BPlusTreeNode = {
      type: "internal",
      keys: value.keys as string[],
      children: value.children as string[],
    };

    validateNode(node);
    return node;
  }

  throw new Error("Unknown B+tree node type");
}
