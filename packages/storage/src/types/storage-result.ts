export type WriteResult =
  | {
      readonly success: true;
      readonly version: string;
    }
  | {
      readonly success: false;
      readonly reason: "conflict";
    };

export type DeleteResult =
  | {
      readonly success: true;
    }
  | {
      readonly success: false;
      readonly reason: "conflict";
    };
