import { parse } from "@babel/parser";
import type { Declaration, ExpressionStatement, Identifier, ImportDeclaration, Node, Statement } from "@babel/types";

export interface TransformedBunCell {
	code: string;
	declaredNames: string[];
}

function sourceFor(code: string, node: { start?: number | null; end?: number | null }): string {
	if (node.start === undefined || node.start === null || node.end === undefined || node.end === null) {
		throw new Error("TypeScript parser returned a node without source offsets");
	}
	return code.slice(node.start, node.end);
}

function collectBindingNames(pattern: Node, names: string[]): void {
	switch (pattern.type) {
		case "Identifier":
			names.push(pattern.name);
			return;
		case "ObjectPattern":
			for (const property of pattern.properties) {
				if (property.type === "RestElement") collectBindingNames(property.argument, names);
				else collectBindingNames(property.value, names);
			}
			return;
		case "ArrayPattern":
			for (const element of pattern.elements) {
				if (element) collectBindingNames(element, names);
			}
			return;
		case "AssignmentPattern":
			collectBindingNames(pattern.left, names);
			return;
		case "RestElement":
			collectBindingNames(pattern.argument, names);
			return;
		case "TSParameterProperty":
			collectBindingNames(pattern.parameter, names);
			return;
		default:
			throw new Error(`Unsupported top-level binding pattern: ${pattern.type}`);
	}
}

function persistNames(names: readonly string[]): string {
	return names.map((name) => `globalThis[${JSON.stringify(name)}] = ${name};`).join("\n");
}

function transformImport(statement: ImportDeclaration, index: number, names: string[]): string {
	if (statement.importKind === "type") return "";
	const runtimeSpecifiers = statement.specifiers.filter(
		(specifier) => specifier.type !== "ImportSpecifier" || specifier.importKind !== "type",
	);
	if (runtimeSpecifiers.length === 0) {
		return `await __primeImport(${JSON.stringify(statement.source.value)});`;
	}
	const moduleName = `__primeModule${index}`;
	const lines = [`const ${moduleName} = await __primeImport(${JSON.stringify(statement.source.value)});`];
	for (const specifier of runtimeSpecifiers) {
		const localName = specifier.local.name;
		names.push(localName);
		if (specifier.type === "ImportNamespaceSpecifier") {
			lines.push(`const ${localName} = ${moduleName};`);
		} else if (specifier.type === "ImportDefaultSpecifier") {
			lines.push(`const ${localName} = ${moduleName}.default;`);
		} else {
			const importedName =
				specifier.imported.type === "Identifier" ? specifier.imported.name : specifier.imported.value;
			lines.push(`const ${localName} = ${moduleName}[${JSON.stringify(importedName)}];`);
		}
	}
	lines.push(persistNames(runtimeSpecifiers.map((specifier) => specifier.local.name)));
	return lines.join("\n");
}

function declarationName(statement: Declaration): Identifier | null {
	if ((statement.type === "FunctionDeclaration" || statement.type === "ClassDeclaration") && statement.id) {
		return statement.id;
	}
	return null;
}

function transformStatement(code: string, statement: Statement, index: number, names: string[]): string {
	if (statement.type === "ImportDeclaration") return transformImport(statement, index, names);
	if (statement.type === "VariableDeclaration") {
		const statementNames: string[] = [];
		for (const declaration of statement.declarations) collectBindingNames(declaration.id, statementNames);
		names.push(...statementNames);
		return `${sourceFor(code, statement)}\n${persistNames(statementNames)}`;
	}
	if (statement.type === "FunctionDeclaration" || statement.type === "ClassDeclaration") {
		const name = declarationName(statement)?.name;
		if (!name) throw new Error(`Anonymous ${statement.type} cannot persist at the top level`);
		names.push(name);
		return `${sourceFor(code, statement)}\n${persistNames([name])}`;
	}
	if (
		statement.type === "TSTypeAliasDeclaration" ||
		statement.type === "TSInterfaceDeclaration" ||
		statement.type === "TSDeclareFunction" ||
		statement.type === "TSModuleDeclaration" ||
		statement.type === "EmptyStatement"
	) {
		return sourceFor(code, statement);
	}
	if (statement.type.startsWith("Export")) {
		throw new Error("Top-level export declarations are not supported in Bun notebook cells");
	}
	return sourceFor(code, statement);
}

export function transformBunCell(code: string): TransformedBunCell {
	const file = parse(code, {
		sourceType: "module",
		plugins: ["typescript", "topLevelAwait", "importAttributes"],
	});
	const names: string[] = [];
	const statements = file.program.body;
	const lastStatement = statements.at(-1);
	const transformed = statements.map((statement, index) => {
		if (statement === lastStatement && statement.type === "ExpressionStatement") {
			const expression = sourceFor(code, (statement as ExpressionStatement).expression);
			return `return (${expression});`;
		}
		return transformStatement(code, statement, index, names);
	});
	return { code: transformed.join("\n"), declaredNames: [...new Set(names)] };
}
