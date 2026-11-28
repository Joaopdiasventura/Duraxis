import ts from "typescript";

export interface StaticConfig {
  ast: ts.SourceFile;
  object: ts.ObjectLiteralExpression;
  connections: Map<string, ts.ObjectLiteralExpression>;
  defaultConnection: string;
  value: unknown;
}
function value(node: ts.Expression): unknown {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (ts.isArrayLiteralExpression(node)) return node.elements.map((item) => value(item));
  if (ts.isObjectLiteralExpression(node))
    return Object.fromEntries(
      node.properties.map((property) =>
        ts.isPropertyAssignment(property) &&
        property.name &&
        (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
          ? [property.name.text, value(property.initializer)]
          : ["[dynamic property]", "[not evaluated]"],
      ),
    );
  return "[executable expression; not evaluated]";
}
export function property(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.PropertyAssignment | undefined {
  const matches = object.properties.filter(
    (item) =>
      item.name &&
      (ts.isIdentifier(item.name) || ts.isStringLiteral(item.name)) &&
      item.name.text === name,
  );
  if (matches.length > 1) throw new Error(`Duplicate configuration property: ${name}`);
  const item = matches[0];
  if (item && !ts.isPropertyAssignment(item))
    throw new Error(`Cannot safely inspect dynamic property: ${name}`);
  return item as ts.PropertyAssignment | undefined;
}
export function inspectStaticConfig(source: string, filename: string): StaticConfig {
  const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  if ((ast as unknown as { parseDiagnostics: readonly unknown[] }).parseDiagnostics.length)
    throw new Error("Invalid configuration syntax; no executable code was evaluated");
  const helpers = new Set<string>();
  for (const statement of ast.statements) {
    if (
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === "@duraxis/core"
    ) {
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings))
        for (const item of bindings.elements)
          if ((item.propertyName ?? item.name).text === "defineDuraxisConfig")
            helpers.add(item.name.text);
    }
    if (ts.isVariableStatement(statement))
      for (const item of statement.declarationList.declarations) {
        if (
          ts.isObjectBindingPattern(item.name) &&
          item.initializer &&
          ts.isCallExpression(item.initializer) &&
          item.initializer.expression.getText(ast) === "require" &&
          item.initializer.arguments[0] &&
          ts.isStringLiteral(item.initializer.arguments[0]) &&
          item.initializer.arguments[0].text === "@duraxis/core"
        )
          for (const binding of item.name.elements)
            if ((binding.propertyName ?? binding.name).getText(ast) === "defineDuraxisConfig")
              helpers.add(binding.name.getText(ast));
      }
  }
  let expression: ts.Expression | undefined;
  for (const statement of ast.statements) {
    if (ts.isExportAssignment(statement)) expression = statement.expression;
    if (
      ts.isExpressionStatement(statement) &&
      ts.isBinaryExpression(statement.expression) &&
      statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      statement.expression.left.getText(ast) === "module.exports"
    )
      expression = statement.expression.right;
  }
  if (
    !expression ||
    !ts.isCallExpression(expression) ||
    !ts.isIdentifier(expression.expression) ||
    !helpers.has(expression.expression.text) ||
    expression.arguments.length !== 1 ||
    !ts.isObjectLiteralExpression(expression.arguments[0]!)
  )
    throw new Error(
      "Configuration is user-authored or dynamic; cannot inspect or modify it safely. Use --evaluate for trusted read operations, or edit it manually. No files were written.",
    );
  const object = expression.arguments[0] as ts.ObjectLiteralExpression;
  if (object.properties.some(ts.isSpreadAssignment))
    throw new Error("Dynamic configuration spreads require manual editing");
  const connections = new Map<string, ts.ObjectLiteralExpression>();
  const named = property(object, "connections");
  let defaultConnection = "default";
  if (named) {
    if (!ts.isObjectLiteralExpression(named.initializer))
      throw new Error("Dynamic connections require manual editing");
    for (const item of named.initializer.properties) {
      if (
        !ts.isPropertyAssignment(item) ||
        !ts.isObjectLiteralExpression(item.initializer) ||
        !(ts.isIdentifier(item.name) || ts.isStringLiteral(item.name))
      )
        throw new Error("Dynamic connections require manual editing");
      if (connections.has(item.name.text)) throw new Error("Duplicate named connection");
      connections.set(item.name.text, item.initializer);
    }
    const selected = property(object, "defaultConnection");
    if (selected && !ts.isStringLiteral(selected.initializer))
      throw new Error("Dynamic defaultConnection requires manual editing");
    defaultConnection = selected
      ? (selected.initializer as ts.StringLiteral).text
      : [...connections.keys()].sort()[0]!;
    if (!connections.has(defaultConnection)) throw new Error("Unknown default connection");
  } else connections.set("default", object);
  return { ast, object, connections, defaultConnection, value: value(object) };
}
export function replaceExpression(
  source: string,
  node: ts.Node,
  replacement: string,
  ast: ts.SourceFile,
): string {
  return source.slice(0, node.getStart(ast)) + replacement + source.slice(node.end);
}
export function setLiteralProperty(
  source: string,
  object: ts.ObjectLiteralExpression,
  key: string,
  literal: string,
  ast: ts.SourceFile,
): string {
  if (object.properties.some(ts.isSpreadAssignment))
    throw new Error("Cannot safely modify configuration spreads");
  const existing = property(object, key);
  if (existing) return replaceExpression(source, existing.initializer, literal, ast);
  const offset = object.properties.end;
  return (
    source.slice(0, offset) +
    `${object.properties.length && !object.properties.hasTrailingComma ? "," : ""}\n  ${key}: ${literal},` +
    source.slice(offset)
  );
}

export function staticDriverInfo(
  config: StaticConfig,
  connection: ts.ObjectLiteralExpression,
): { driver?: string; directory?: string } {
  const driver = property(connection, "driver")?.initializer;
  if (!driver || !ts.isArrowFunction(driver)) return {};
  const body = driver.body;
  if (!ts.isNewExpression(body) && !ts.isCallExpression(body)) return {};
  const expression = body.expression;
  const name = ts.isIdentifier(expression)
    ? expression.text
    : ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)
      ? expression.expression.text
      : undefined;
  let kind: string | undefined;
  for (const statement of config.ast.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const bindings = statement.importClause?.namedBindings;
      if (
        bindings &&
        ts.isNamedImports(bindings) &&
        bindings.elements.some((item) => item.name.text === name)
      )
        kind = statement.moduleSpecifier.text.replace("@duraxis/storage-", "");
    }
    if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations) {
        if (
          ts.isObjectBindingPattern(declaration.name) &&
          declaration.name.elements.some((item) => item.name.getText(config.ast) === name) &&
          declaration.initializer &&
          ts.isCallExpression(declaration.initializer) &&
          declaration.initializer.expression.getText(config.ast) === "require"
        ) {
          const module = declaration.initializer.arguments[0];
          if (module && ts.isStringLiteral(module))
            kind = module.text.replace("@duraxis/storage-", "");
        }
      }
  }
  const options = body.arguments?.[0];
  let directory =
    options && ts.isObjectLiteralExpression(options)
      ? property(options, "directory")?.initializer
      : undefined;
  if (
    directory &&
    ts.isCallExpression(directory) &&
    directory.arguments.length === 1 &&
    directory.expression.getText(config.ast) === "resolvePath"
  )
    directory = directory.arguments[0];
  if (
    directory &&
    ts.isBinaryExpression(directory) &&
    directory.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
  )
    directory = directory.right;
  return {
    driver: kind,
    directory: directory && ts.isStringLiteral(directory) ? directory.text : undefined,
  };
}
