import ts from "typescript";
import { posix } from "node:path";

/** Surgical AST-guided edits preserve every unrelated byte, including comments. */
export function integrateNestModule(source: string, path: string, configPath: string): string {
  const ast = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  let moduleName: string | undefined;
  let duraxisName: string | undefined;
  let configName: string | undefined;
  let reference = posix.relative(posix.dirname(path), configPath).replace(/\.[cm]?ts$/, ".js");
  if (!reference.startsWith(".")) reference = `./${reference}`;
  const identifiers = new Set<string>();
  const collect = (node: ts.Node) => {
    if (ts.isIdentifier(node)) identifiers.add(node.text);
    ts.forEachChild(node, collect);
  };
  collect(ast);
  const unique = (base: string) => {
    let result = base;
    for (let i = 2; identifiers.has(result); i++) result = `${base}${i}`;
    identifiers.add(result);
    return result;
  };
  for (const statement of ast.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier))
      continue;
    const specifier = statement.moduleSpecifier.text;
    const bindings = statement.importClause?.namedBindings;
    if (statement.importClause?.isTypeOnly) continue;
    if (bindings && ts.isNamespaceImport(bindings)) {
      if (specifier === "@nestjs/common") moduleName = `${bindings.name.text}.Module`;
      if (specifier === "@duraxis/nestjs") duraxisName = `${bindings.name.text}.DuraxisModule`;
    }
    if (bindings && ts.isNamedImports(bindings))
      for (const item of bindings.elements) {
        if (item.isTypeOnly) continue;
        if (specifier === "@nestjs/common" && (item.propertyName ?? item.name).text === "Module")
          moduleName = item.name.text;
        if (
          specifier === "@duraxis/nestjs" &&
          (item.propertyName ?? item.name).text === "DuraxisModule"
        )
          duraxisName = item.name.text;
      }
    if (specifier === reference && statement.importClause?.name)
      configName = statement.importClause.name.text;
  }
  let commonjs = false;
  for (const statement of ast.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      const call = declaration.initializer;
      if (
        !call ||
        !ts.isCallExpression(call) ||
        call.expression.getText(ast) !== "require" ||
        call.arguments.length !== 1 ||
        !ts.isStringLiteral(call.arguments[0]!)
      )
        continue;
      const specifier = (call.arguments[0] as ts.StringLiteral).text;
      commonjs = !/\.[cm]?ts$/.test(path);
      if (ts.isIdentifier(declaration.name) && specifier === reference)
        configName = declaration.name.text;
      if (ts.isObjectBindingPattern(declaration.name))
        for (const element of declaration.name.elements) {
          if (
            specifier === "@nestjs/common" &&
            (element.propertyName ?? element.name).getText(ast) === "Module"
          )
            moduleName = element.name.getText(ast);
          if (
            specifier === "@duraxis/nestjs" &&
            (element.propertyName ?? element.name).getText(ast) === "DuraxisModule"
          )
            duraxisName = element.name.getText(ast);
        }
    }
  }
  if (!moduleName)
    throw new Error(
      `Cannot safely integrate ${path}: import Module from @nestjs/common using a named import`,
    );
  const roots = ast.statements
    .filter(ts.isClassDeclaration)
    .filter((node) => node.name?.text === "AppModule");
  if (roots.length !== 1)
    throw new Error(`Cannot safely integrate ${path}: expected one AppModule class`);
  const decorators = ts.getDecorators(roots[0]!) ?? [];
  let decorator = decorators
    .map((item) => item.expression)
    .find(
      (expression) =>
        ts.isCallExpression(expression) && expression.expression.getText(ast) === moduleName,
    );
  if (!decorator) {
    for (const statement of ast.statements) {
      if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression))
        continue;
      const apply = statement.expression;
      if (
        apply.arguments.length === 1 &&
        apply.arguments[0]!.getText(ast) === "AppModule" &&
        ts.isCallExpression(apply.expression) &&
        apply.expression.expression.getText(ast) === moduleName
      )
        decorator = apply.expression;
    }
  }
  if (
    !decorator ||
    !ts.isCallExpression(decorator) ||
    decorator.arguments.length !== 1 ||
    !ts.isObjectLiteralExpression(decorator.arguments[0]!)
  )
    throw new Error(`Cannot safely integrate ${path}: @Module metadata must be an inline object`);
  const metadata = decorator.arguments[0]! as ts.ObjectLiteralExpression;
  const properties = metadata.properties.filter(
    (property) =>
      property.name &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
      property.name.text === "imports",
  );
  if (metadata.properties.some(ts.isSpreadAssignment))
    throw new Error(`Cannot safely integrate ${path}: spread module metadata may override imports`);
  if (properties.length > 1)
    throw new Error(`Cannot safely integrate ${path}: duplicate imports property`);
  const property = properties[0];
  let array: ts.ArrayLiteralExpression | undefined;
  if (property) {
    if (!ts.isPropertyAssignment(property) || !ts.isArrayLiteralExpression(property.initializer))
      throw new Error(`Cannot safely integrate ${path}: imports must be an inline array`);
    array = property.initializer;
    if (
      duraxisName &&
      array.elements.some(
        (element) =>
          ts.isCallExpression(element) &&
          ts.isPropertyAccessExpression(element.expression) &&
          element.expression.expression.getText(ast) === duraxisName &&
          ["forRoot", "forRootAsync"].includes(element.expression.name.text),
      )
    ) {
      // Preserve an existing application-specific registration; never open a second connection implicitly.
      throw new Error(
        `Existing Duraxis root registration in ${path}; preserve its configuration and integrate the new configuration explicitly`,
      );
    }
  }
  const imports: string[] = [];
  if (!duraxisName) {
    duraxisName = unique("DuraxisModule");
    imports.push(
      commonjs
        ? `const { DuraxisModule${duraxisName === "DuraxisModule" ? "" : `: ${duraxisName}`} } = require("@duraxis/nestjs");`
        : `import { DuraxisModule${duraxisName === "DuraxisModule" ? "" : ` as ${duraxisName}`} } from "@duraxis/nestjs";`,
    );
  }
  if (!configName) {
    configName = unique("duraxisConfig");
    imports.push(
      commonjs
        ? `const ${configName} = require(${JSON.stringify(reference)});`
        : `import ${configName} from ${JSON.stringify(reference)};`,
    );
  }
  const registration = `${duraxisName}.forRoot(${configName})`;
  const offset = array ? array.elements.end : metadata.properties.end;
  const addition = array
    ? `${array.elements.length && !array.elements.hasTrailingComma ? "," : ""}\n    ${registration},`
    : `${metadata.properties.length && !metadata.properties.hasTrailingComma ? "," : ""}\n  imports: [${registration}],`;
  const importOffset = ast.statements.filter(ts.isImportDeclaration).at(-1)?.end ?? 0;
  return (
    source.slice(0, importOffset) +
    (imports.length ? "\n" + imports.join("\n") + "\n" : "") +
    source.slice(importOffset, offset) +
    addition +
    source.slice(offset)
  );
}
