import type { EntityClass } from "@duraxis/orm";

export const DEFAULT_DURAXIS_CONNECTION = "default";

const repositoryTokens = new WeakMap<Function, Map<string, symbol>>();

export function normalizeDuraxisConnectionName(name?: string): string {
  const normalized = name ?? DEFAULT_DURAXIS_CONNECTION;
  if (
    typeof normalized != "string" ||
    normalized.trim() == "" ||
    normalized.length > 128 ||
    normalized.includes("\0")
  )
    throw new TypeError(
      "Duraxis connection name must be a non-empty string of at most 128 characters",
    );
  return normalized;
}

function connectionToken(kind: string, connectionName?: string): symbol {
  const name = normalizeDuraxisConnectionName(connectionName);
  return Symbol.for(`@duraxis/nestjs/${kind}/${encodeURIComponent(name)}`);
}

export function getDuraxisOrmToken(connectionName?: string): symbol {
  return connectionToken("orm", connectionName);
}

export function getDuraxisDatabaseToken(connectionName?: string): symbol {
  return connectionToken("database", connectionName);
}

export function getDuraxisRepositoryToken<TEntity extends object>(
  entity: EntityClass<TEntity>,
  connectionName?: string,
): symbol {
  const name = normalizeDuraxisConnectionName(connectionName);
  let byConnection = repositoryTokens.get(entity);
  if (!byConnection) {
    byConnection = new Map();
    repositoryTokens.set(entity, byConnection);
  }
  let token = byConnection.get(name);
  if (!token) {
    token = Symbol(`@duraxis/nestjs/repository/${name}/${entity.name}`);
    byConnection.set(name, token);
  }
  return token;
}

export function getDuraxisOptionsToken(connectionName?: string): symbol {
  return connectionToken("options", connectionName);
}

export function getDuraxisConnectionToken(connectionName?: string): symbol {
  return connectionToken("connection", connectionName);
}
