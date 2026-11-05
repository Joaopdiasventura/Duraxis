export type WriteCondition =
  | {
      readonly type: "if-absent";
    }
  | {
      readonly type: "if-version";
      readonly version: string;
    };

export interface WriteOptions {
  readonly condition: WriteCondition;
}

export interface DeleteOptions {
  readonly condition: WriteCondition;
}
