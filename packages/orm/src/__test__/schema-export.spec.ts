import { describe, expect, it } from "vitest";
import { DuraxisDatabase } from "@duraxis/core";
import { MemoryStorageDriver } from "@duraxis/storage-memory";
import {
  Entity,
  Column,
  PrimaryKey,
  Index,
  ManyToMany,
  JoinTable,
  exportSchema,
  DuraxisORM,
} from "../index.js";
class Base {
  @PrimaryKey() id!: string;
  @Column({ type: "string" }) inherited!: string;
}
@Entity("export_users")
class User extends Base {
  @Index() @Column({ type: "string" }) name!: string;
  @JoinTable({ name: "export_user_tags", joinColumn: "userId", inverseJoinColumn: "tagId" })
  @ManyToMany(() => Tag, (tag) => tag.users)
  tags?: Tag[];
}
@Entity("export_tags")
class Tag {
  @PrimaryKey() id!: string;
  @Column({ type: "string" }) label!: string;
  @ManyToMany(() => User, (user) => user.tags) users?: User[];
}
describe("standalone schema export", () => {
  it("includes inherited fields, junctions, foreign keys and supporting indexes deterministically", () => {
    const schemas = exportSchema([User, Tag]);
    expect(schemas).toEqual(exportSchema([Tag, User]));
    expect(schemas.map((schema) => schema.name)).toEqual([
      "export_tags",
      "export_user_tags",
      "export_users",
    ]);
    expect(schemas.find((schema) => schema.name == "export_users")?.fields?.inherited.type).toBe(
      "string",
    );
    expect(schemas.find((schema) => schema.name == "export_user_tags")?.foreignKeys).toHaveLength(
      2,
    );
  });
  it("strictly validates managed indexes without rejecting unrelated collections", async () => {
    const db = new DuraxisDatabase({ storage: new MemoryStorageDriver() });
    await db.defineCollections([...exportSchema([User, Tag]), { name: "unrelated", indexes: [] }]);
    await new DuraxisORM({
      database: db,
      entities: [User, Tag],
      schema: { mode: "validate-managed" },
    }).initialize();
    await db.addIndex("export_users", { name: "extra", unique: false, field: "name" });
    await expect(
      new DuraxisORM({
        database: db,
        entities: [User, Tag],
        schema: { mode: "validate-managed" },
      }).initialize(),
    ).rejects.toThrow("Unexpected managed index");
    await new DuraxisORM({
      database: db,
      entities: [User, Tag],
      schema: { mode: "validate" },
    }).initialize();
  });
});
