export type NodeId = string;

export type EncodedKey = string;

export type EncodedValue = string;

export interface LeafNode {
  readonly type: "leaf";
  readonly keys: readonly EncodedKey[];
  readonly values: readonly EncodedValue[];
}

export interface InternalNode {
  readonly type: "internal";
  readonly keys: readonly EncodedKey[];
  readonly children: readonly NodeId[];
}

export type BPlusTreeNode = LeafNode | InternalNode;

export interface IndexEntry {
  readonly key: Uint8Array;
  readonly value: Uint8Array;
}

export interface ScanOptions {
  readonly gt?: Uint8Array;
  readonly gte?: Uint8Array;
  readonly lt?: Uint8Array;
  readonly lte?: Uint8Array;
  readonly limit?: number;
}
