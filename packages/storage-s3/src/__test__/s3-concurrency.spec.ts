import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { PutObjectCommand } from "@aws-sdk/client-s3";
import { CommitOutcomeUnknownError, DuraxisDatabase } from "@duraxis/core";
import { Column, Entity, PrimaryKey, type Repository } from "@duraxis/orm";
import {
  DuraxisModule,
  InjectDuraxisRepository,
  Transactional,
  getDuraxisRepositoryToken,
} from "@duraxis/nestjs";
import { Injectable, Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { S3StorageDriver } from "../index.js";
import { FakeS3, testOptions } from "./fake-s3.js";
import { defineDatabaseScenarios } from "./database-scenarios.js";

let service: FakeS3;
const drivers: S3StorageDriver[] = [];
beforeEach(() => {
  service = new FakeS3();
  service.install();
});
afterEach(async () => {
  await Promise.all(drivers.splice(0).map(async (driver) => await driver.close()));
  vi.restoreAllMocks();
});
function create(prefix = "isolated"): S3StorageDriver {
  const driver = new S3StorageDriver({ ...testOptions, prefix });
  drivers.push(driver);
  return driver;
}

describe("S3 driver with the real Duraxis engines and fake S3 transport", () => {
  defineDatabaseScenarios(() => {
    const prefix = randomUUID();
    return () => create(prefix);
  });

  it("recovers a lost manifest response through transaction ID and retained history", async () => {
    const driver = create();
    const database = new DuraxisDatabase({ storage: driver });
    let armed = true;
    service.after = (command) => {
      if (
        command instanceof PutObjectCommand &&
        command.input.Key?.endsWith("/__duraxis/v1/manifest") &&
        armed
      ) {
        armed = false;
        throw Object.assign(new Error("response lost"), { code: "ECONNRESET" });
      }
    };
    try {
      let failure: CommitOutcomeUnknownError | undefined;
      try {
        await database.transaction((tx) => tx.put("unknown", new Uint8Array([7])));
      } catch (error) {
        if (!(error instanceof CommitOutcomeUnknownError)) throw error;
        failure = error;
      }
      expect(failure).toBeInstanceOf(CommitOutcomeUnknownError);
      if (!failure) throw new Error("Expected unknown commit outcome");
      expect(failure.cause).toMatchObject({ code: "OUTCOME_UNKNOWN" });
      expect(await database.getCommitStatus(failure.transactionId)).toBe("committed");
      await database.transaction((tx) => tx.put("next", new Uint8Array([8])));
      expect(await database.getCommitStatus(failure.transactionId)).toBe("committed");
      expect(await database.verifyHistory()).toBe(2);
      await database.transaction(async (tx) =>
        expect(await tx.get("unknown")).toEqual(new Uint8Array([7])),
      );
    } finally {
      await database.close({ closeStorage: true });
    }
  });

  it("leaves a nonpublished transaction unknown after a connection failure", async () => {
    const driver = create();
    const database = new DuraxisDatabase({ storage: driver });
    service.before = (command) => {
      if (
        command instanceof PutObjectCommand &&
        command.input.Key?.endsWith("/__duraxis/v1/manifest")
      )
        throw Object.assign(new Error("request lost"), { code: "ECONNRESET" });
    };
    try {
      try {
        await database.transaction((tx) => tx.put("absent", new Uint8Array([1])));
        throw new Error("Expected unknown outcome");
      } catch (error) {
        if (!(error instanceof CommitOutcomeUnknownError)) throw error;
        service.before = undefined;
        expect(await database.getCommitStatus(error.transactionId)).toBe("unknown");
        await database.transaction(async (tx) => expect(await tx.get("absent")).toBeNull());
      }
    } finally {
      await database.close({ closeStorage: true });
    }
  });

  it("rejects stale listing versions during real core garbage collection", async () => {
    const driver = create();
    const key = `__duraxis/v1/objects/${randomUUID()}`;
    const first = await driver.put(key, new Uint8Array([1]), { condition: { type: "if-absent" } });
    if (!first.success) throw new Error("Expected write");
    const database = new DuraxisDatabase({ storage: driver });
    try {
      const dryRun = await database.collectGarbage(driver, { dryRun: true, olderThanMs: 0 });
      expect(dryRun.candidates).toBe(1);
      expect(dryRun.deleted).toBe(0);
      let changed = false;
      service.before = async (command) => {
        if (
          !changed &&
          command instanceof PutObjectCommand &&
          command.input.Metadata?.["duraxis-state"] == "deleted"
        ) {
          changed = true;
          const second = create();
          await second.put(key, new Uint8Array([2]), {
            condition: { type: "if-version", version: first.version },
          });
        }
      };
      const collected = await database.collectGarbage(driver, {
        dryRun: false,
        exclusiveMaintenance: true,
        olderThanMs: 0,
      });
      expect(changed).toBe(true);
      expect(collected.deleted).toBe(0);
      expect((await driver.get(key))?.data).toEqual(new Uint8Array([2]));
    } finally {
      await database.close({ closeStorage: true });
    }
  });
});

@Entity("s3_nest_users")
class User {
  @PrimaryKey() id!: string;
  @Column({ type: "string", required: true }) name!: string;
}

@Injectable()
class UserService {
  public constructor(@InjectDuraxisRepository(User) private readonly users: Repository<User>) {}
  @Transactional()
  public async create(id: string, fail = false): Promise<void> {
    await this.users.save({ id, name: id });
    if (fail) throw new Error("rollback");
  }
}

@Module({ imports: [DuraxisModule.forFeature([User])], providers: [UserService] })
class UserModule {}

it.each([true, false])(
  "preserves Nest forRootAsync lifecycle with closeStorage=%s",
  async (closeStorage) => {
    const driver = create();
    const close = vi.spyOn(driver, "close");
    const module = await Test.createTestingModule({
      imports: [
        DuraxisModule.forRootAsync({
          useFactory: async () => ({
            driver,
            closeStorage,
            autoLoadEntities: true,
            schema: { mode: "create" },
          }),
        }),
        UserModule,
      ],
    }).compile();
    try {
      await module.init();
      await module.get(UserService).create("committed");
      await expect(module.get(UserService).create("rolled-back", true)).rejects.toThrow("rollback");
      const users = module.get<Repository<User>>(getDuraxisRepositoryToken(User));
      expect((await users.findById("committed"))?.name).toBe("committed");
      expect(await users.findById("rolled-back")).toBeNull();
    } finally {
      await module.close();
    }
    expect(close).toHaveBeenCalledTimes(closeStorage ? 1 : 0);
  },
);
