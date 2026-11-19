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
const RESPONSE_METHODS = ["status", "type", "set", "send", "json", "write", "end"];

/** `response.status(200).end("ok")`: fixed-argument calls on the response parameter only. */
function responseCall(value: unknown, response: string): boolean {
  const call = node(value);
  const callee = node(call?.callee);
  return (
    call?.type === "CallExpression" &&
    callee?.type === "MemberExpression" &&
    callee.computed === false &&
    RESPONSE_METHODS.some((name) => identifier(callee.property, name)) &&
    nodes(call.arguments).every((item) =>
      ["StringLiteral", "NumericLiteral"].includes(item.type),
    ) &&
    (identifier(callee.object, response) || responseCall(callee.object, response))
  );
}

function fixedResponseHandler(value: unknown): boolean {
  const handler = node(value);
  const params = nodes(handler?.params);
  const response = params[1]?.name;
  if (
    !["FunctionExpression", "ArrowFunctionExpression"].includes(handler?.type ?? "") ||
    params.length !== 2 ||
    params.some((param) => param.type !== "Identifier") ||
    typeof response !== "string"
  )
    return false;
  const body = node(handler!.body);
  if (body?.type !== "BlockStatement") return responseCall(body, response);
  const statements = nodes(body.body);
  return (
    statements.length > 0 &&
    nodes(body.directives).length === 0 &&
    statements.every(
      (item) => item.type === "ExpressionStatement" && responseCall(item.expression, response),
    )
  );
}

/**
 * Syntax inspection only: no application imports, evaluation, or package lifecycle.
 * Setup later executes this module, so it is an allowlist of exactly four statements.
 */
export function inspectExpressSource(source: string): ApplicationSyntax {
  const fail = () => new Error("Unsupported or ambiguous Express source/telemetry ownership");
  const program = parse(source, { sourceType: "module", plugins: ["typescript"] }).program;
  const body = program.body as unknown as Node[];
  if (program.interpreter || program.directives.length || body.length !== 4) throw fail();
  const [imported, constructor, route, listener] = body as [Node, Node, Node, Node];
  const specifiers = nodes(imported.specifiers);
  const declarations = nodes(constructor.declarations);
  const call = node(declarations[0]?.init);
  if (
    imported.type !== "ImportDeclaration" ||
    imported.importKind !== "value" ||
    imported.phase ||
    nodes(imported.attributes).length ||
    node(imported.source)?.value !== "express" ||
    specifiers.length !== 1 ||
    specifiers[0]!.type !== "ImportDefaultSpecifier" ||
    !identifier(specifiers[0]!.local, "express") ||
    constructor.type !== "VariableDeclaration" ||
    constructor.declare ||
    declarations.length !== 1 ||
    !identifier(declarations[0]!.id, "app") ||
    call?.type !== "CallExpression" ||
    !identifier(call.callee, "express") ||
    nodes(call.arguments).length !== 0 ||
    constructor.end === undefined
  )
    throw fail();
  const routeCall = node(route.expression);
  const arguments_ = nodes(routeCall?.arguments);
  if (
    route.type !== "ExpressionStatement" ||
    routeCall?.type !== "CallExpression" ||
    !member(routeCall.callee, "app", "get") ||
    arguments_.length !== 2 ||
    arguments_[0]!.type !== "StringLiteral" ||
    typeof arguments_[0]!.value !== "string" ||
    !fixedResponseHandler(arguments_[1])
  )
    throw fail();
  const raw = (arguments_[0]!.extra as { raw?: string } | undefined)?.raw;
  if (raw !== JSON.stringify(arguments_[0]!.value) && raw !== `'${arguments_[0]!.value as string}'`)
    throw fail();
  const listenCall = node(listener.expression);
  if (
    listener.type !== "ExpressionStatement" ||
    listenCall?.type !== "CallExpression" ||
    !member(listenCall.callee, "app", "listen")
  )
    throw fail();
  const listenerArguments = nodes(listenCall.arguments);
  const portArgument = listenerArguments[0];
  const port =
    portArgument?.type === "CallExpression" && identifier(portArgument.callee, "Number")
      ? nodes(portArgument.arguments).length === 1
        ? nodes(portArgument.arguments)[0]
        : undefined
      : portArgument;
  if (
    listenerArguments.length !== 2 ||
    port?.type !== "MemberExpression" ||
    port.computed !== false ||
    !member(port.object, "process", "env") ||
    !identifier(port.property, "PORT") ||
    listenerArguments[1]?.type !== "StringLiteral" ||
    listenerArguments[1].value !== "127.0.0.1"
  )
    throw fail();
  return {
    constructorEnd: constructor.end,
    importOffset: 0,
    requestPath: arguments_[0]!.value as string,
  };
}

const PYTHON_INSPECT = String.raw`
import ast, json, sys
source = sys.stdin.read()
tree = ast.parse(source)
compile(source, '<setup-static-inspection>', 'exec')
lines = source.splitlines(keepends=True)
def endline(item):
    return sum(len(line.encode('utf-8')) for line in lines[:item.end_lineno])
def name(item, value):
    return isinstance(item, ast.Name) and item.id == value
def member(item, owner, attr):
    return isinstance(item, ast.Attribute) and name(item.value, owner) and item.attr == attr
def text(item):
    return isinstance(item, ast.Constant) and type(item.value) is str
def same(item, statement):
    return ast.dump(item) == ast.dump(ast.parse(statement).body[0])
# Insertion after a statement's line must not cross another semicolon statement.
assert all(left.end_lineno < right.lineno for left, right in zip(tree.body, tree.body[1:]))
index = 0
if tree.body and isinstance(tree.body[0], ast.Expr) and text(tree.body[0].value): index = 1
while index < len(tree.body) and isinstance(tree.body[index], ast.ImportFrom) and tree.body[index].module == '__future__': index += 1
# Setup later executes this module: after the prologue only these five statements are allowed.
statements = tree.body[index:]
assert len(statements) == 5
first, second, constructor, handler, statement = statements
assert (same(first, 'import os') and same(second, 'from flask import Flask')) or (same(first, 'from flask import Flask') and same(second, 'import os'))
assert same(constructor, 'app = Flask(__name__)')
assert isinstance(handler, ast.FunctionDef) and ast.dump(handler.args) == ast.dump(ast.parse('def f(): pass').body[0].args) and handler.returns is None and not getattr(handler, 'type_params', None)
assert len(handler.body) == 1 and isinstance(handler.body[0], ast.Return) and text(handler.body[0].value)
assert len(handler.decorator_list) == 1
route = handler.decorator_list[0]
assert isinstance(route, ast.Call) and member(route.func, 'app', 'get') and len(route.args) == 1 and not route.keywords and text(route.args[0])
assert ast.get_source_segment(source, route.args[0]) in (json.dumps(route.args[0].value), "'" + route.args[0].value + "'")
if isinstance(statement, ast.If):
    assert len(statement.body) == 1 and not statement.orelse
    condition = statement.test
    assert isinstance(condition, ast.Compare) and name(condition.left, '__name__') and len(condition.ops) == 1 and isinstance(condition.ops[0], ast.Eq) and len(condition.comparators) == 1 and isinstance(condition.comparators[0], ast.Constant) and condition.comparators[0].value == '__main__'
    statement = statement.body[0]
assert isinstance(statement, ast.Expr) and isinstance(statement.value, ast.Call) and member(statement.value.func, 'app', 'run')
listener = statement.value
assert not listener.args and all(keyword.arg in ('host', 'port') for keyword in listener.keywords)
keywords = {keyword.arg: keyword.value for keyword in listener.keywords}
assert len(keywords) == len(listener.keywords) and 'port' in keywords
if 'host' in keywords:
    assert isinstance(keywords['host'], ast.Constant) and keywords['host'].value == '127.0.0.1'
port = keywords['port']
assert isinstance(port, ast.Call) and name(port.func, 'int') and len(port.args) == 1 and not port.keywords
value = port.args[0]
assert isinstance(value, ast.Subscript) and member(value.value, 'os', 'environ') and isinstance(value.slice, ast.Constant) and value.slice.value == 'PORT'
offset = endline(tree.body[index - 1]) if index else sum(len(line.encode('utf-8')) for line in lines[:tree.body[0].lineno - 1])
print(json.dumps(dict(constructorEnd=endline(constructor), importOffset=offset, requestPath=route.args[0].value)))
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
