import { parse } from "@babel/parser";
import { spawnSync } from "node:child_process";

type Node = { type: string; start?: number; end?: number; [key: string]: unknown };
export interface ApplicationSyntax {
  constructorEnd: number;
  importOffset: number;
  requestPath: string;
}
function node(value: unknown): Node | undefined {
  return value && typeof value === "object" && typeof (value as Node).type === "string"
    ? (value as Node)
    : undefined;
}
function nodes(value: unknown): Node[] {
  return Array.isArray(value) ? value.flatMap((value) => (node(value) ? [node(value)!] : [])) : [];
}
function identifier(value: unknown, name: string): boolean {
  const item = node(value);
  return item?.type === "Identifier" && item.name === name;
}
function member(value: unknown, owner: string, name: string): boolean {
  const item = node(value);
  return (
    item?.type === "MemberExpression" &&
    item.computed === false &&
    identifier(item.object, owner) &&
    identifier(item.property, name)
  );
}
function walk(value: unknown, visit: (value: Node, parent?: Node) => void, parent?: Node): void {
  if (Array.isArray(value)) for (const item of value) walk(item, visit, parent);
  else if (node(value)) {
    visit(value as Node, parent);
    for (const [key, item] of Object.entries(value as Node))
      if (key !== "loc" && key !== "comments" && key !== "tokens") walk(item, visit, value as Node);
  }
}

/** Syntax inspection only: no application imports, evaluation, or package lifecycle. */
export function inspectExpressSource(source: string): ApplicationSyntax {
  const fail = () => new Error("Unsupported or ambiguous Express source/telemetry ownership");
  const program = parse(source, { sourceType: "module", plugins: ["typescript"] }).program;
  const body = program.body as unknown as Node[];
  if (program.interpreter || program.directives.length) throw fail();
  const constructors = body.filter((item) => {
    if (item.type !== "VariableDeclaration") return false;
    const declarations = nodes(item.declarations);
    const call = node(declarations[0]?.init);
    return (
      declarations.length === 1 &&
      identifier(declarations[0]?.id, "app") &&
      call?.type === "CallExpression" &&
      identifier(call.callee, "express") &&
      nodes(call.arguments).length === 0
    );
  });
  if (constructors.length !== 1 || constructors[0]!.end === undefined) throw fail();
  const imports = body.filter((item) => item.type === "ImportDeclaration");
  if (
    !imports.some(
      (item) =>
        node(item.source)?.value === "express" &&
        nodes(item.specifiers).some(
          (specifier) =>
            specifier.type === "ImportDefaultSpecifier" && identifier(specifier.local, "express"),
        ),
    )
  )
    throw fail();
  for (const item of imports) {
    const source = node(item.source)?.value;
    if (
      source === "@opentelemetry/api" &&
      nodes(item.specifiers).some(
        (specifier) =>
          specifier.type !== "ImportSpecifier" ||
          !["trace", "SpanKind"].some((name) => identifier(specifier.imported, name)),
      )
    )
      throw fail();
    // Unknown bootstraps/import graphs could initialize a competing context manager.
    if (
      typeof source !== "string" ||
      !(
        source === "express" ||
        source === "@opentelemetry/api" ||
        ["node:fs", "node:fs/promises", "node:timers/promises", "node:stream"].includes(source)
      )
    )
      throw fail();
  }
  let routeCalls = 0;
  walk(program, (item, parent) => {
    if (
      identifier(item, "app") &&
      !(
        (parent?.type === "VariableDeclarator" &&
          parent.id === item &&
          node(parent.init)?.type === "CallExpression" &&
          identifier(node(parent.init)?.callee, "express")) ||
        (parent?.type === "MemberExpression" && parent.object === item)
      )
    )
      throw fail();
    if (
      item.type === "MemberExpression" &&
      identifier(item.object, "app") &&
      !(
        parent?.type === "CallExpression" &&
        parent.callee === item &&
        ["get", "listen"].some((name) => member(item, "app", name))
      )
    )
      throw fail();
    if (
      item.type === "ExportAllDeclaration" ||
      (item.type === "ExportNamedDeclaration" && item.source) ||
      item.type === "TSImportEqualsDeclaration"
    )
      throw fail();
    if (
      (item.type === "AssignmentExpression" && identifier(item.left, "app")) ||
      (item.type === "UpdateExpression" && identifier(item.argument, "app"))
    )
      throw fail();
    if (
      item.type === "CallExpression" &&
      node(item.callee)?.type === "MemberExpression" &&
      identifier(node(item.callee)?.object, "app") &&
      !["get", "listen"].some((name) => member(item.callee, "app", name))
    )
      throw fail();
    if (item.type === "CallExpression" && member(item.callee, "app", "get")) routeCalls++;
    if (
      item.type === "ImportExpression" ||
      (item.type === "CallExpression" &&
        (node(item.callee)?.type === "Import" ||
          identifier(item.callee, "require") ||
          identifier(item.callee, "eval")))
    )
      throw fail();
    if (
      item.type === "MemberExpression" &&
      ["setGlobalContextManager", "disable", "register"].some((name) =>
        identifier(item.property, name),
      )
    )
      throw fail();
  });
  const routes = body
    .filter((item) => item.type === "ExpressionStatement")
    .map((item) => node(item.expression))
    .filter(
      (item) => item?.type === "CallExpression" && member(item.callee, "app", "get"),
    ) as Node[];
  if (routes.length !== 1 || routeCalls !== 1 || routes[0]!.start! <= constructors[0]!.end!)
    throw fail();
  const arguments_ = nodes(routes[0]!.arguments);
  if (
    arguments_.length !== 2 ||
    arguments_[0]!.type !== "StringLiteral" ||
    typeof arguments_[0]!.value !== "string"
  )
    throw fail();
  const raw = (arguments_[0]!.extra as { raw?: string } | undefined)?.raw;
  if (raw !== JSON.stringify(arguments_[0]!.value) && raw !== `'${arguments_[0]!.value as string}'`)
    throw fail();
  const handler = arguments_[1]!;
  if (
    !["FunctionExpression", "ArrowFunctionExpression"].includes(handler.type) &&
    !(
      handler.type === "Identifier" &&
      body.some(
        (item) => item.type === "FunctionDeclaration" && identifier(item.id, String(handler.name)),
      )
    )
  )
    throw fail();
  const listeners = body
    .filter((item) => item.type === "ExpressionStatement")
    .map((item) => node(item.expression))
    .filter((item) => item?.type === "CallExpression" && member(item.callee, "app", "listen"));
  if (listeners.length !== 1) throw fail();
  let port = false;
  walk(nodes(listeners[0]!.arguments)[0], (item) => {
    if (
      item.type === "MemberExpression" &&
      !item.computed &&
      member(item.object, "process", "env") &&
      identifier(item.property, "PORT")
    )
      port = true;
  });
  if (!port) throw fail();
  return {
    constructorEnd: constructors[0]!.end!,
    importOffset: 0,
    requestPath: arguments_[0]!.value as string,
  };
}

const PYTHON_INSPECT = String.raw`
import ast, json, sys
source = sys.stdin.read()
tree = ast.parse(source)
parents = {child: parent for parent in ast.walk(tree) for child in ast.iter_child_nodes(parent)}
lines = source.splitlines(keepends=True)
def endline(item):
    return sum(len(line.encode('utf-8')) for line in lines[:item.end_lineno])
def name(item, value):
    return isinstance(item, ast.Name) and item.id == value
def member(item, owner, attr):
    return isinstance(item, ast.Attribute) and name(item.value, owner) and item.attr == attr
constructors = [item for item in tree.body if isinstance(item, ast.Assign) and len(item.targets) == 1 and name(item.targets[0], 'app') and isinstance(item.value, ast.Call) and name(item.value.func, 'Flask') and len(item.value.args) == 1 and name(item.value.args[0], '__name__') and not item.value.keywords]
assert len(constructors) == 1
for item in ast.walk(tree):
    parent = parents.get(item)
    if name(item, 'app'):
        assert (parent is constructors[0] and item in parent.targets) or (isinstance(parent, ast.Attribute) and parent.value is item)
    if isinstance(item, ast.Attribute) and name(item.value, 'app'):
        assert isinstance(parent, ast.Call) and parent.func is item and item.attr in ('get', 'run')
# Insertion after a statement's line must not cross another semicolon statement.
assert all(left.end_lineno < right.lineno for left, right in zip(tree.body, tree.body[1:]))
assert any(isinstance(item, ast.ImportFrom) and item.module == 'flask' and any(alias.name == 'Flask' and alias.asname in (None, 'Flask') for alias in item.names) for item in tree.body)
routes = [(item, decorator) for item in tree.body if isinstance(item, ast.FunctionDef) for decorator in item.decorator_list if isinstance(decorator, ast.Call) and member(decorator.func, 'app', 'get')]
all_routes = [item for item in ast.walk(tree) if isinstance(item, ast.Call) and member(item.func, 'app', 'get')]
assert len(routes) == len(all_routes) == 1
handler, route = routes[0]
assert handler.decorator_list == [route]
assert handler.lineno > constructors[0].end_lineno and len(route.args) == 1 and not route.keywords and isinstance(route.args[0], ast.Constant) and isinstance(route.args[0].value, str)
assert ast.get_source_segment(source, route.args[0]) in (json.dumps(route.args[0].value), "'" + route.args[0].value + "'")
listeners = [item for item in ast.walk(tree) if isinstance(item, ast.Call) and member(item.func, 'app', 'run')]
assert len(listeners) == 1
assert any(isinstance(item, ast.Subscript) and member(item.value, 'os', 'environ') and isinstance(item.slice, ast.Constant) and item.slice.value == 'PORT' for item in ast.walk(listeners[0]))
index = 0
if tree.body and isinstance(tree.body[0], ast.Expr) and isinstance(tree.body[0].value, ast.Constant) and isinstance(tree.body[0].value.value, str): index = 1
while index < len(tree.body) and isinstance(tree.body[index], ast.ImportFrom) and tree.body[index].module == '__future__': index += 1
offset = endline(tree.body[index - 1]) if index else sum(len(line.encode('utf-8')) for line in lines[:tree.body[0].lineno - 1])
print(json.dumps(dict(constructorEnd=endline(constructors[0]), importOffset=offset, requestPath=route.args[0].value)))
`;

/** An isolated stdlib parser never imports/executes the customer's Python module. */
export function inspectFlaskSource(source: string): ApplicationSyntax {
  const result = spawnSync("python3", ["-I", "-B", "-S", "-c", PYTHON_INSPECT], {
    input: source,
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 8192,
    shell: false,
  });
  if (result.status !== 0)
    throw new Error("An isolated Python 3 parser and unambiguous Flask source are required");
  const value = JSON.parse(result.stdout) as ApplicationSyntax;
  const bytes = Buffer.from(source);
  for (const field of ["constructorEnd", "importOffset"] as const) {
    if (!Number.isInteger(value[field]) || value[field] < 0 || value[field] > bytes.length)
      throw new Error("Invalid Python source position");
    value[field] = bytes.subarray(0, value[field]).toString("utf8").length;
  }
  if (typeof value.requestPath !== "string") throw new Error("Invalid Python route");
  return value;
}
