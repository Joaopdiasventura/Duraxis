import { createHash } from "node:crypto";
import type { Transaction } from "@duraxis/core";
import { DuplicateRecordError, RecordNotFoundError } from "../errors/index.js";
import type { EntityMetadata, RelationMetadata } from "../metadata/entity-metadata.js";

function associationId(ownerId: string, inverseId: string): string {
  return createHash("sha256")
    .update(JSON.stringify([ownerId, inverseId]))
    .digest("hex");
}

export class RelationOperations<TEntity extends object = Record<string, unknown>> {
  public constructor(
    private readonly metadata: EntityMetadata<TEntity>,
    private readonly relation: RelationMetadata<TEntity>,
    private readonly write: (action: (transaction: Transaction) => Promise<void>) => Promise<void>,
  ) {
    if (relation.kind != "many-to-many" || !relation.joinTable)
      throw new Error(`Relation ${metadata.collection}.${relation.property} is not ManyToMany`);
  }

  public async add(sourceId: string, targetId: string): Promise<void> {
    await this.write(async (tx) => {
      if (!(await tx.getDocument(this.metadata.collection, sourceId)))
        throw new RecordNotFoundError(`Record not found: ${this.metadata.collection}/${sourceId}`);

      if (!(await tx.getDocument(this.relation.targetCollection, targetId)))
        throw new RecordNotFoundError(
          `Record not found: ${this.relation.targetCollection}/${targetId}`,
        );

      const join = this.relation.joinTable!;

      const ownerId = this.relation.owner ? sourceId : targetId;

      const inverseId = this.relation.owner ? targetId : sourceId;

      const id = associationId(ownerId, inverseId);

      if (await tx.getDocument(join.name, id))
        throw new DuplicateRecordError(`Relation already exists: ${join.name}/${id}`);

      tx.putDocument(join.name, id, {
        [join.ownerField]: ownerId,
        [join.inverseField]: inverseId,
      });
    });
  }

  public async remove(sourceId: string, targetId: string): Promise<boolean> {
    let removed = false;

    await this.write(async (tx) => {
      const ownerId = this.relation.owner ? sourceId : targetId;
      const inverseId = this.relation.owner ? targetId : sourceId;
      const id = associationId(ownerId, inverseId);
      if (!(await tx.getDocument(this.relation.joinTable!.name, id))) return;
      tx.deleteDocument(this.relation.joinTable!.name, id);
      removed = true;
    });

    return removed;
  }
}
