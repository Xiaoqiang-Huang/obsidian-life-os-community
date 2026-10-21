import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const interpreter = fileURLToPath(new URL("../vendor/review-safe-mcp-validator.ts", import.meta.url));

// Keep MCP/Zod schema validation, but remove code generation. Do not weaken the
// community scanner or replace constructors with obscured aliases.
export const reviewSafeSdkValidation = {
  name: "lifeos-sdk-interpreted-validation",
  setup(build) {
    // SDK core's optional Node listener-limit tuning must tolerate native DOM
    // AbortSignal in Electron. Restrict this import adaptation to SDK sources.
    build.onResolve({ filter: /^events$/ }, args => {
      if (/[\\/]@anthropic-ai[\\/]claude-agent-sdk[\\/]/.test(args.importer)) return { path: "events", namespace: "lifeos-sdk-renderer-events" };
    });
    build.onLoad({ filter: /^events$/, namespace: "lifeos-sdk-renderer-events" }, () => ({
      contents: `export * from "node:events"; export { rendererSetMaxListeners as setMaxListeners } from "./sdk-renderer-events.ts";`, loader: "js", resolveDir: fileURLToPath(new URL("../vendor/", import.meta.url))
    }));
    build.onLoad({ filter: /[\\/]@cfworker[\\/]json-schema[\\/]dist[\\/](?:esm|commonjs)[\\/]validate\.js$/ }, async args => {
      const source = await readFile(args.path, "utf8");
      const ast = ts.createSourceFile(args.path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      const sites = [];
      for (const node of ast.statements) {
        if (!ts.isFunctionDeclaration(node) || node.name?.text !== "validate" || !node.body) continue;
        const names = node.parameters.map(p => p.name.getText(ast));
        if (names[0] !== "instance" || names[1] !== "schema" || !names.includes("instanceLocation") || !names.includes("schemaLocation")) continue;
        const variables = node.body.statements.filter(ts.isVariableStatement).flatMap(s => s.declarationList.declarations);
        if (!variables.some(d => d.name.getText(ast) === "errors")
          || !variables.some(d => ts.isObjectBindingPattern(d.name) && d.name.elements.some(e => e.name.getText(ast) === "$format"))) continue;
        for (const statement of node.body.statements) {
          if (ts.isIfStatement(statement) && statement.expression.getText(ast) === "Array.isArray($type)") sites.push(statement.getStart(ast));
        }
      }
      if (sites.length !== 1) throw new Error(`Unrecognised CfWorker format validation shape: ${args.path}`);
      // Keep native recursive schema evaluation ($ref/oneOf/not/conditionals),
      // adding only the two missing AJV-compatible formats. Do not rewrite
      // schemas or treat data inside const/enum as schemas. Byte is whole-string
      // base64: trailing newlines and whitespace are intentionally rejected.
      const guard = String.raw`if (($format === "int32" && typeof instance === "number" &&
        (!Number.isInteger(instance) || instance < -2147483648 || instance > 2147483647)) ||
        ($format === "byte" && typeof instance === "string" &&
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$(?![\s\S])/.test(instance))) {
        errors.push({ instanceLocation, keyword: "format", keywordLocation: schemaLocation + "/format",
          error: "Instance does not match format " + $format + "." });
      }
      `;
      return { contents: source.slice(0, sites[0]) + guard + source.slice(sites[0]), loader: "js" };
    });
    build.onLoad({ filter: /[\\/]@anthropic-ai[\\/]claude-agent-sdk[\\/]core-[^\\/]+\.mjs$/ }, async args => {
      const source = await readFile(args.path, "utf8");
      const ast = ts.createSourceFile(args.path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      const edits = [];
      const visit = node => {
        if (ts.isPropertyAccessExpression(node) && node.name.text === "url" && ts.isMetaProperty(node.expression)
          && node.expression.keywordToken === ts.SyntaxKind.ImportKeyword) {
          edits.push({ start: node.getStart(ast), end: node.end });
        }
        ts.forEachChild(node, visit);
      };
      visit(ast);
      if (edits.length === 0) return undefined;
      if (edits.length !== 1) throw new Error("Unrecognised SDK core module URL shape");
      // CJS bundles do not have import.meta.url. Only core's builtin require
      // factory needs an absolute anchor; all peers are bundled, and CLI
      // resolution MUST be the explicit path supplied by our process host.
      const edit = edits[0];
      return { contents: source.slice(0, edit.start) + 'require("node:path").join(process.cwd(), "lifeos-sdk-bundled.cjs")' + source.slice(edit.end), loader: "js" };
    });
    build.onResolve({ filter: /(?:^@modelcontextprotocol\/sdk\/validation\/ajv$|(?:^|\/)ajv-provider\.js$)/ }, args => {
      if (args.path.startsWith("@modelcontextprotocol/sdk/") || /[\\/]@modelcontextprotocol[\\/]sdk[\\/]/.test(args.importer)) return { path: interpreter };
      return undefined;
    });
    build.onLoad({ filter: /[\\/]zod[\\/]v4[\\/]core[\\/](?:util|doc|compile)\.js$/ }, async args => {
      const source = await readFile(args.path, "utf8");
      const ast = ts.createSourceFile(args.path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
      const replacements = [];
      const replace = (node, text) => replacements.push({ start: node.getStart(ast), end: node.end, text });
      const visit = node => {
        if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === "allowsEval" && node.initializer) {
          replace(node.initializer, "cached(() => false)");
        }
        if (ts.isMethodDeclaration(node) && node.name?.getText(ast) === "compile" && node.body && node.parent.name?.text === "Doc") {
          replace(node.body, '{ throw new Error("Life OS disables Zod code generation; use interpreted parsing."); }');
        }
        if (ts.isFunctionDeclaration(node) && node.name?.text === "compile" && node.body) {
          replace(node.body, '{ throw new ZodCompileUnsupportedError("Life OS disables Zod code generation; use interpreted parsing."); }');
        }
        ts.forEachChild(node, visit);
      };
      visit(ast);
      if (replacements.length !== 1) throw new Error(`Unrecognised Zod JIT module shape: ${args.path}`);
      let contents = source;
      for (const edit of replacements.sort((a, b) => b.start - a.start)) contents = contents.slice(0, edit.start) + edit.text + contents.slice(edit.end);
      return { contents, loader: "js" };
    });
  }
};
