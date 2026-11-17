import { DuraxisDatabase } from "@duraxis/core";
import { MemoryStorageDriver } from "@duraxis/storage-memory";
import { describe, expect, it } from "vitest";
import {
  Column,
  DuraxisORM,
  Entity,
  JoinTable,
  ManyToMany,
  ManyToOne,
  OneToMany,
  OneToOne,
  PrimaryKey,
} from "../index.js";

@Entity("relation_users")
class RelationUser {
  @PrimaryKey() id!: string;
  @Column({ type: "string", required: true }) name!: string;
  @OneToMany(() => RelationPost, (post) => post.author) posts?: RelationPost[];
  @OneToOne(() => RelationProfile, (profile) => profile.user) profile?: RelationProfile | null;
}

@Entity("relation_posts")
class RelationPost {
  @PrimaryKey() id!: string;
  @Column({ type: "string", required: true }) title!: string;
  @Column({ type: "string", required: true }) authorId!: string;
  @ManyToOne(() => RelationUser, { foreignKey: "authorId", onDelete: "CASCADE" })
  author?: RelationUser;
  @JoinTable({ name: "relation_post_tags", joinColumn: "postId", inverseJoinColumn: "tagId" })
  @ManyToMany(() => RelationTag, (tag) => tag.posts)
  tags?: RelationTag[];
}

@Entity("relation_profiles")
class RelationProfile {
  @PrimaryKey() id!: string;
  @Column({ type: "string", required: true }) userId!: string;
  @Column({ type: "string", required: true }) bio!: string;
  @OneToOne(() => RelationUser, { foreignKey: "userId", onDelete: "CASCADE" })
  user?: RelationUser;
}

@Entity("relation_tags")
class RelationTag {
  @PrimaryKey() id!: string;
  @Column({ type: "string", required: true }) label!: string;
  @ManyToMany(() => RelationPost, (post) => post.tags) posts?: RelationPost[];
}

async function fixture() {
  const database = new DuraxisDatabase({ storage: new MemoryStorageDriver() });
  const orm = new DuraxisORM({
    database,
    entities: [RelationUser, RelationPost, RelationProfile, RelationTag],
    schema: { mode: "create" },
  });
  await orm.initialize();
  return { database, orm };
}

describe("ORM relations", () => {
  it("maps decorators to core foreign keys and batches nested relation loading", async () => {
    const { database, orm } = await fixture();
    await orm.transaction(async (manager) => {
      await manager.getRepository(RelationUser).insert({ id: "u1", name: "User" });
      await manager.getRepository(RelationPost).insert({
        id: "p1",
        title: "First",
        authorId: "u1",
      });
      await manager.getRepository(RelationPost).insert({
        id: "p2",
        title: "Second",
        authorId: "u1",
      });
      await manager.getRepository(RelationProfile).insert({ id: "pr1", userId: "u1", bio: "bio" });
    });
    const queriesBefore = database.getMetrics().queries;
    const user = await orm.getRepository(RelationUser).findOne({
      where: { id: "u1" },
      relations: { posts: { author: true }, profile: true },
    });
    expect(user?.posts?.map((post) => post.id).sort()).toEqual(["p1", "p2"]);
    expect(user?.posts?.[0]?.author?.id).toBe("u1");
    expect(user?.profile?.bio).toBe("bio");
    expect(database.getMetrics().queries - queriesBefore).toBe(4);
    const definitions = await database.getCollectionDefinitions();
    expect(
      definitions.find((schema) => schema.name == "relation_posts")?.foreignKeys?.[0]?.field,
    ).toBe("authorId");
    expect(
      definitions
        .find((schema) => schema.name == "relation_profiles")
        ?.indexes.some((index) => index.unique),
    ).toBe(true);
  });

  it("keeps root pagination stable and sees pending relations inside a transaction", async () => {
    const { orm } = await fixture();
    await orm.transaction(async (manager) => {
      const users = manager.getRepository(RelationUser);
      const posts = manager.getRepository(RelationPost);
      for (const id of ["1", "2", "3"]) await users.insert({ id, name: `User ${id}` });
      await posts.insert({ id: "p1", title: "post", authorId: "1" });
      const loaded = await users.findById("1", { relations: { posts: true } });
      expect(loaded?.posts?.map((post) => post.id)).toEqual(["p1"]);
    });
    const page = await orm.getRepository(RelationUser).findPage({
      orderBy: { id: "ASC" },
      limit: 2,
      relations: { posts: true },
    });
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBeTypeOf("string");
  });

  it("creates, loads and removes bidirectional ManyToMany associations", async () => {
    const { orm } = await fixture();
    await orm.getRepository(RelationUser).insert({ id: "u1", name: "User" });
    await orm.getRepository(RelationPost).insert({ id: "p1", title: "post", authorId: "u1" });
    await orm.getRepository(RelationTag).insert({ id: "t1", label: "tag" });
    await orm.getRepository(RelationPost).relations("tags").add("p1", "t1");
    await expect(orm.getRepository(RelationPost).relations("tags").add("p1", "t1")).rejects.toThrow(
      "Relation already exists",
    );
    expect(
      (await orm.getRepository(RelationPost).findById("p1", { relations: { tags: true } }))
        ?.tags?.[0]?.id,
    ).toBe("t1");
    expect(
      (await orm.getRepository(RelationTag).findById("t1", { relations: { posts: true } }))
        ?.posts?.[0]?.id,
    ).toBe("p1");
    expect(await orm.getRepository(RelationTag).relations("posts").remove("t1", "p1")).toBe(true);
    expect(
      (await orm.getRepository(RelationPost).findById("p1", { relations: { tags: true } }))?.tags,
    ).toEqual([]);
  });

  it("cascades entity and junction deletions atomically", async () => {
    const { database, orm } = await fixture();
    await orm.transaction(async (manager) => {
      await manager.getRepository(RelationUser).insert({ id: "u1", name: "User" });
      await manager.getRepository(RelationPost).insert({ id: "p1", title: "post", authorId: "u1" });
      await manager.getRepository(RelationTag).insert({ id: "t1", label: "tag" });
      await manager.getRepository(RelationPost).relations("tags").add("p1", "t1");
    });
    await orm.getRepository(RelationUser).delete("u1");
    expect(await orm.getRepository(RelationPost).findById("p1")).toBeNull();
    expect(await database.scanCollection("relation_post_tags")).toEqual([]);
    expect(await orm.getRepository(RelationTag).findById("t1")).not.toBeNull();
  });
});
