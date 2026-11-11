import { describe, expect, it } from "vitest";
import {
  Column,
  Entity,
  EntityMapper,
  Index,
  InvalidColumnError,
  InvalidMetadataError,
  MetadataRegistry,
  MissingPrimaryKeyError,
  PrimaryKey,
} from "../index.js";

@Index(
  "age_name",
  [
    { property: "age", order: "DESC" },
    { property: "name", order: "ASC" },
  ],
  { unique: false },
)
@Entity("mapped_users")
class MappedUser {
  @PrimaryKey()
  id!: string;

  @Column({ type: "string", name: "display_name", required: true })
  name!: string;

  @Index({ unique: true })
  @Column({ type: "string", required: true })
  email!: string;

  @Column({ type: "number", nullable: true })
  age!: number | null;

  @Column({ type: "date" })
  createdAt?: Date;

  greet(): string {
    return `hello ${this.name}`;
  }
}

describe("decorator metadata and entity mapping", () => {
  it("finalizes isolated immutable metadata with simple and compound indexes", () => {
    @Entity("other_users")
    class OtherUser {
      @PrimaryKey()
      id!: string;
      @Column({ type: "string" })
      name?: string;
    }

    const registry = new MetadataRegistry([MappedUser, OtherUser]).finalize();
    const users = registry.get(MappedUser);
    const other = registry.get(OtherUser);
    expect(users.collection).toBe("mapped_users");
    expect(users.primaryKey).toBe("id");
    expect(users.columnForProperty("name")?.field).toBe("display_name");
    expect(users.indexes).toEqual([
      {
        name: "email",
        unique: true,
        fields: [{ property: "email", field: "email", order: "ASC" }],
      },
      {
        name: "age_name",
        unique: false,
        fields: [
          { property: "age", field: "age", order: "DESC" },
          { property: "name", field: "display_name", order: "ASC" },
        ],
      },
    ]);
    expect(other.columns.map((column) => column.property)).toEqual(["name"]);
    expect(Object.isFrozen(users.columns)).toBe(true);
    expect(() => registry.register(MappedUser)).toThrow("finalized");
  });

  it("supports inherited decorated properties without leaking sibling metadata", () => {
    abstract class Base {
      @PrimaryKey()
      id!: string;
      @Column({ type: "date", required: true })
      createdAt!: Date;
    }
    @Entity("inherited_a")
    class ChildA extends Base {
      @Column({ type: "string" })
      value?: string;
    }
    @Entity("inherited_b")
    class ChildB extends Base {
      @Column({ type: "boolean" })
      active?: boolean;
    }
    const registry = new MetadataRegistry([ChildA, ChildB]).finalize();
    expect(registry.get(ChildA).columns.map((column) => column.property)).toEqual([
      "createdAt",
      "value",
    ]);
    expect(registry.get(ChildB).columns.map((column) => column.property)).toEqual([
      "createdAt",
      "active",
    ]);
  });

  it("rejects missing/duplicate keys, duplicate columns and unknown index properties", () => {
    @Entity("no_key")
    class NoKey {
      @Column({ type: "string" })
      value?: string;
    }
    expect(() => new MetadataRegistry([NoKey])).toThrow(MissingPrimaryKeyError);

    @Entity("two_keys")
    class TwoKeys {
      @PrimaryKey()
      first!: string;
      @PrimaryKey()
      second!: string;
    }
    expect(() => new MetadataRegistry([TwoKeys])).toThrow(InvalidMetadataError);

    @Index("bad_index", [{ property: "missing" }])
    @Entity("bad_index_entity")
    class BadIndex {
      @PrimaryKey()
      id!: string;
    }
    expect(() => new MetadataRegistry([BadIndex])).toThrow("unknown column");

    @Entity("duplicate_column")
    class DuplicateColumn {
      @PrimaryKey()
      id!: string;
      @Column({ type: "string", name: "same" })
      first?: string;
      @Column({ type: "string", name: "same" })
      second?: string;
    }
    expect(() => new MetadataRegistry([DuplicateColumn])).toThrow("Duplicate persisted");

    @Entity("duplicate_entity_a")
    @Entity("duplicate_entity_b")
    class DuplicateEntityDecorator {
      @PrimaryKey()
      id!: string;
    }
    expect(() => new MetadataRegistry([DuplicateEntityDecorator])).toThrow("duplicate @Entity");

    @Entity("duplicate_indexes")
    class DuplicateIndexes {
      @PrimaryKey()
      id!: string;
      @Index()
      @Index()
      @Column({ type: "string" })
      value?: string;
    }
    expect(() => new MetadataRegistry([DuplicateIndexes])).toThrow("Duplicate index");
  });

  it("serializes declared fields only and hydrates dates, null and missing fields safely", () => {
    const metadata = new MetadataRegistry([MappedUser]).finalize().get(MappedUser);
    const mapper = new EntityMapper(metadata);
    const source = mapper.create({
      id: "u1",
      name: "Ada",
      email: "ada@example.com",
      age: null,
      createdAt: new Date("2026-02-03T04:05:06.000Z"),
    });
    Object.defineProperty(source, "ignored", { value: "not persisted", enumerable: true });
    const serialized = mapper.serialize(source);
    expect(serialized).toEqual({
      id: "u1",
      document: {
        display_name: "Ada",
        email: "ada@example.com",
        age: null,
        createdAt: "2026-02-03T04:05:06.000Z",
      },
    });
    const hydrated = mapper.hydrate("u1", {
      display_name: "Ada",
      email: "ada@example.com",
      age: null,
      createdAt: "2026-02-03T04:05:06.000Z",
    });
    expect(hydrated).toBeInstanceOf(MappedUser);
    expect(hydrated.createdAt).toBeInstanceOf(Date);
    expect(hydrated.age).toBeNull();
    expect(hydrated.greet()).toBe("hello Ada");
    const missing = mapper.hydrate("u2", { display_name: "Lin", email: "lin@example.com" });
    expect(Object.hasOwn(missing, "age")).toBe(false);
  });

  it("does not execute constructors or setters while creating and hydrating", () => {
    let constructors = 0;
    let setters = 0;
    @Entity("safe_entities")
    class SafeEntity {
      public constructor() {
        constructors++;
      }
      @PrimaryKey()
      id!: string;
      @Column({ type: "string", required: true })
      set value(_value: string) {
        setters++;
      }
    }
    const mapper = new EntityMapper(new MetadataRegistry([SafeEntity]).finalize().get(SafeEntity));
    const entity = mapper.create({ id: "1", value: "created" });
    expect(constructors).toBe(0);
    expect(setters).toBe(0);
    expect(mapper.hydrate("1", { value: "hydrated" })).toBeInstanceOf(SafeEntity);
    expect(setters).toBe(0);
    expect(mapper.serialize(entity).document).toEqual({ value: "created" });
  });

  it("rejects incompatible values before persistence", () => {
    const mapper = new EntityMapper(new MetadataRegistry([MappedUser]).finalize().get(MappedUser));
    const invalid = mapper.create({
      id: "u1",
      name: "Ada",
      email: "ada@example.com",
      age: "old" as never,
    });
    expect(() => mapper.serialize(invalid)).toThrow(InvalidColumnError);
  });
});
