import { ResourceExhaustedError } from "../resources/resource-manager.js";
import type { StorageDriver } from "@duraxis/storage";
import type { Snapshot } from "../commit/manifest.js";

interface Coordination {
  active: number;
  maintenance: boolean;
  snapshots: Set<Snapshot>;
}

const states = new WeakMap<StorageDriver, Coordination>();

export function storageCoordination(storage: StorageDriver): Coordination {
  let state = states.get(storage);
  if (!state) {
    state = { active: 0, maintenance: false, snapshots: new Set() };
    states.set(storage, state);
  }
  return state;
}

const commits = new WeakMap<StorageDriver, { tail: Promise<void>; queued: number }>();

export async function coordinateCommit<T>(
  storage: StorageDriver,
  maximum: number,
  action: () => Promise<T>,
): Promise<T> {
  let state = commits.get(storage);
  
  if (!state) {
    state = { tail: Promise.resolve(), queued: 0 };
    commits.set(storage, state);
  }

  if (state.queued >= maximum) throw new ResourceExhaustedError("queuedOperations", maximum);

  state.queued++;
  const previous = state.tail;
  let release!: () => void;
  
  state.tail = new Promise<void>((resolve) => {
    release = resolve;
  });

  try {
    await previous;
    return await action();
  } finally {
    state.queued--;
    release();
  }
}
