import { defineStorageConformanceSuite } from "@duraxis/storage-testkit";
import { MemoryStorageDriver } from "../memory-storage.driver.js";

defineStorageConformanceSuite({
  name: "MemoryStorageDriver",

  createDriver: () => new MemoryStorageDriver(),
});
