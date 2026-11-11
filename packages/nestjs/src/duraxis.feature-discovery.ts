import { DiscoveryService } from "@nestjs/core";
import type { EntityClass } from "@duraxis/orm";

export interface DuraxisFeatureEntitiesMetadata {
  readonly connectionName: string;
  readonly entities: readonly EntityClass[];
}

export const DuraxisFeatureEntities =
  DiscoveryService.createDecorator<DuraxisFeatureEntitiesMetadata>();

export function discoverFeatureEntities(
  discovery: DiscoveryService,
  connectionName: string,
): readonly EntityClass[] {
  const entities = new Set<EntityClass>();
  for (const provider of discovery.getProviders({ metadataKey: DuraxisFeatureEntities.KEY })) {
    const metadata = discovery.getMetadataByDecorator(DuraxisFeatureEntities, provider);
    if (metadata?.connectionName != connectionName) continue;
    for (const entity of metadata.entities) entities.add(entity);
  }
  return [...entities];
}
