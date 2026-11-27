import {
  type CollectionDefinition,
  type DocumentRecord,
  type FieldDefinition,
  type ForeignKeyDefinition,
  type SecondaryIndexDefinition,
  type Transaction,
  indexFields,
} from "@duraxis/core";

export class SchemaEditor {
  readonly #tx: Transaction;

  public constructor(tx: Transaction) {
    this.#tx = tx;
  }

  public inspect(): readonly CollectionDefinition[] {
    return this.#tx.getCollectionDefinitions();
  }

  public definition(name: string): CollectionDefinition {
    const result = this.inspect().find((schema) => schema.name == name);
    if (!result) throw new Error(`Unknown collection: ${name}`);
    return result;
  }

  public createCollection(definition: CollectionDefinition): void {
    this.#tx.defineCollection(definition);
  }

  public createCollections(definitions: readonly CollectionDefinition[]): void {
    this.#tx.defineCollections(definitions);
  }

  public alterCollection(name: string, definition: CollectionDefinition): void {
    this.#tx.alterCollection(name, definition);
  }

  public dropCollection(name: string): void {
    this.#tx.dropCollection(name);
  }

  public addField(collection: string, name: string, definition: FieldDefinition): void {
    const schema = this.definition(collection);

    if (Object.hasOwn(schema.fields ?? {}, name)) throw new Error(`Field already exists: ${name}`);

    this.alterCollection(collection, {
      ...schema,
      fields: { ...schema.fields, [name]: definition },
    });
  }

  public alterField(collection: string, name: string, definition: FieldDefinition): void {
    const schema = this.definition(collection);

    if (!Object.hasOwn(schema.fields ?? {}, name)) throw new Error(`Unknown field: ${name}`);

    this.alterCollection(collection, {
      ...schema,
      fields: { ...schema.fields, [name]: definition },
    });
  }

  public async removeField(
    collection: string,
    name: string,
    options: { strategy: "reject-if-populated" | "delete-values" },
  ): Promise<void> {
    const schema = this.definition(collection);
    const fields = { ...schema.fields };

    if (!Object.hasOwn(fields, name)) throw new Error(`Unknown field: ${name}`);

    if (
      schema.indexes.some((index) => indexFields(index).some((part) => part.field == name)) ||
      schema.foreignKeys?.some((key) => key.field == name)
    )
      throw new Error("Remove dependent indexes and foreign keys first");

    delete fields[name];

    if (options.strategy == "reject-if-populated") {
      for await (const row of this.#tx.scanCollection(collection))
        if (Object.hasOwn(row.document, name))
          throw new Error(`Field is populated: ${collection}/${name}`);
    } else if (options.strategy != "delete-values")
      throw new Error("Explicit field removal strategy required");

    this.alterCollection(collection, { ...schema, fields });

    if (options.strategy == "delete-values")
      for await (const row of this.#tx.scanCollection(collection)) {
        const document = { ...row.document };

        delete document[name];
        this.#tx.putDocument(collection, row.id, document);
      }
  }

  public async renameField(collection: string, from: string, to: string): Promise<void> {
    const schema = this.definition(collection);

    const fields = { ...schema.fields };

    if (!Object.hasOwn(fields, from) || Object.hasOwn(fields, to))
      throw new Error("Invalid field rename");

    for await (const row of this.#tx.scanCollection(collection))
      if (Object.hasOwn(row.document, to)) throw new Error(`Rename would overwrite ${to}`);

    fields[to] = fields[from]!;

    delete fields[from];

    this.alterCollection(collection, {
      ...schema,
      fields,
      indexes: schema.indexes.map((index) => ({
        name: index.name,
        unique: index.unique,
        fields: indexFields(index).map((part) => ({
          ...part,
          field: part.field == from ? to : part.field,
        })),
      })),
      foreignKeys: schema.foreignKeys?.map((key) => ({
        ...key,
        field: key.field == from ? to : key.field,
      })),
    });

    for await (const row of this.#tx.scanCollection(collection)) {
      const document = { ...row.document };

      if (Object.hasOwn(document, from)) {
        document[to] = document[from];
        delete document[from];
      }

      this.#tx.putDocument(collection, row.id, document);
    }
  }

  public addIndex(collection: string, index: SecondaryIndexDefinition): void {
    this.#tx.addIndex(collection, index);
  }

  public removeIndex(collection: string, name: string): void {
    this.#tx.removeIndex(collection, name);
  }

  public addForeignKey(collection: string, definition: ForeignKeyDefinition): void {
    const schema = this.definition(collection);
    if (schema.foreignKeys?.some((key) => key.name == definition.name))
      throw new Error("Foreign key already exists");
    this.alterCollection(collection, {
      ...schema,
      foreignKeys: [...(schema.foreignKeys ?? []), definition],
    });
  }

  public removeForeignKey(collection: string, name: string): void {
    const schema = this.definition(collection);

    if (!schema.foreignKeys?.some((key) => key.name == name))
      throw new Error("Unknown foreign key");

    this.alterCollection(collection, {
      ...schema,
      foreignKeys: schema.foreignKeys.filter((key) => key.name != name),
    });
  }
}

export interface MigrationContext {
  readonly signal: AbortSignal;
  readonly schema: SchemaEditor;
  readonly get: Transaction["getDocument"];
  readonly scan: Transaction["scanCollection"];
  readonly put: Transaction["putDocument"];
  readonly delete: Transaction["deleteDocument"];
  transform(
    collection: string,
    transform: (document: DocumentRecord, id: string) => DocumentRecord | Promise<DocumentRecord>,
  ): Promise<void>;
}

export function createMigrationContext(tx: Transaction): MigrationContext {
  return Object.freeze({
    signal: tx.signal,
    schema: new SchemaEditor(tx),
    get: tx.getDocument.bind(tx),
    scan: tx.scanCollection.bind(tx),
    put: tx.putDocument.bind(tx),
    delete: tx.deleteDocument.bind(tx),
    async transform(
      collection: string,
      transform: (document: DocumentRecord, id: string) => DocumentRecord | Promise<DocumentRecord>,
    ) {
      for await (const row of tx.scanCollection(collection))
        tx.putDocument(collection, row.id, await transform(row.document, row.id));
    },
  });
}
