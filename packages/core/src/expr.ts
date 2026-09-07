/**
 * A tiny, safe expression language for workflow conditions and assertions.
 *
 * Grammar:
 *   or      := and ("||" and)*
 *   and     := cmp ("&&" cmp)*
 *   cmp     := add (("=="|"!="|"<"|"<="|">"|">=") add)?
 *   add     := unary (("+"|"-") unary)*
 *   unary   := ("!"|"-") unary | primary
 *   primary := literal | dotted-identifier | "(" or ")"
 *
 * Identifiers resolve against a caller-supplied scope by dotted path
 * (e.g. `steps.login.status`, `vars.env`). There is no eval, no function
 * calls, no arbitrary property assignment — conditions cannot escape the
 * sandbox. Parsing and evaluation are separate: compile once, catch syntax
 * errors at save time, evaluate cheaply at run time.
 */

export type ExprScope = Record<string, unknown>;

type Node =
  | { t: "lit"; v: string | number | boolean | null }
  | { t: "id"; path: string[] }
  | { t: "un"; op: "!" | "-"; v: Node }
  | { t: "bin"; op: string; l: Node; r: Node };

type Token =
  | { type: "and" } | { type: "or" } | { type: "eq" } | { type: "ne" }
  | { type: "lt" } | { type: "le" } | { type: "gt" } | { type: "ge" }
  | { type: "lparen" } | { type: "rparen" } | { type: "plus" } | { type: "minus" } | { type: "not" }
  | { type: "num"; value: number } | { type: "str"; value: string } | { type: "id"; value: string };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const rest = src.slice(i);
    const ch = src[i]!;
    if (/\s/.test(ch)) { i++; continue; }
    let matched = false;
    for (const [lit, type] of [["&&", "and"], ["||", "or"], ["==", "eq"], ["!=", "ne"], ["<=", "le"], [">=", "ge"], ["<", "lt"], [">", "gt"], ["(", "lparen"], [")", "rparen"], ["+", "plus"], ["-", "minus"], ["!", "not"]] as const) {
      if (rest.startsWith(lit)) { tokens.push({ type } as Token); i += lit.length; matched = true; break; }
    }
    if (matched) continue;
    const num = rest.match(/^\d+(\.\d+)?/);
    if (num) { tokens.push({ type: "num", value: parseFloat(num[0]) }); i += num[0].length; continue; }
    const str = rest.match(/^'([^']*)'|^"([^"]*)"/);
    if (str) { tokens.push({ type: "str", value: str[1] ?? str[2] ?? "" }); i += str[0].length; continue; }
    const id = rest.match(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*/);
    if (id) { tokens.push({ type: "id", value: id[0] }); i += id[0].length; continue; }
    throw new Error(`Unexpected character ${JSON.stringify(ch)} at position ${i}`);
  }
  return tokens;
}

export function parse(src: string): Node {
  const tokens = tokenize(src);
  let pos = 0;
  const peek = () => tokens[pos];
  const eat = (type: Token["type"]): boolean => (tokens[pos]?.type === type ? (pos++, true) : false);

  function primary(): Node {
    const tk = tokens[pos];
    if (!tk) throw new Error("Unexpected end of expression");
    pos++;
    switch (tk.type) {
      case "num": return { t: "lit", v: tk.value };
      case "str": return { t: "lit", v: tk.value };
      case "id": {
        if (tk.value === "true") return { t: "lit", v: true };
        if (tk.value === "false") return { t: "lit", v: false };
        if (tk.value === "null") return { t: "lit", v: null };
        return { t: "id", path: tk.value.split(".") };
      }
      case "lparen": {
        const v = or();
        if (!eat("rparen")) throw new Error("Expected ')'");
        return v;
      }
      default: throw new Error(`Unexpected token "${tk.type}"`);
    }
  }
  function unary(): Node {
    if (eat("not")) return { t: "un", op: "!", v: unary() };
    if (eat("minus")) return { t: "un", op: "-", v: unary() };
    return primary();
  }
  function add(): Node {
    let l = unary();
    for (;;) {
      if (peek()?.type === "plus") { pos++; l = { t: "bin", op: "+", l, r: unary() }; }
      else if (peek()?.type === "minus") { pos++; l = { t: "bin", op: "-", l, r: unary() }; }
      else return l;
    }
  }
  function cmp(): Node {
    const l = add();
    for (const op of ["eq", "ne", "lt", "le", "gt", "ge"] as const) {
      if (eat(op)) return { t: "bin", op, l, r: add() };
    }
    return l;
  }
  function and(): Node {
    let l = cmp();
    while (peek()?.type === "and") { pos++; l = { t: "bin", op: "and", l, r: cmp() }; }
    return l;
  }
  function or(): Node {
    let l = and();
    while (peek()?.type === "or") { pos++; l = { t: "bin", op: "or", l, r: and() }; }
    return l;
  }

  const ast = or();
  if (pos !== tokens.length) throw new Error(`Unexpected trailing tokens at position ${pos}`);
  return ast;
}

function resolvePath(path: string[], scope: ExprScope): unknown {
  let cur: unknown = scope;
  for (const seg of path) {
    if (cur && typeof cur === "object" && seg in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      throw new Error(`Unknown identifier "${path.join(".")}"`);
    }
  }
  return cur;
}

export function evaluate(ast: Node, scope: ExprScope): unknown {
  switch (ast.t) {
    case "lit": return ast.v;
    case "id": return resolvePath(ast.path, scope);
    case "un": {
      const v = evaluate(ast.v, scope);
      return ast.op === "!" ? !v : numOp("-", 0, typeof v === "number" ? v : NaN);
    }
    case "bin": {
      if (ast.op === "and") return truthy(evaluate(ast.l, scope)) && truthy(evaluate(ast.r, scope));
      if (ast.op === "or") return truthy(evaluate(ast.l, scope)) || truthy(evaluate(ast.r, scope));
      const l = evaluate(ast.l, scope);
      const r = evaluate(ast.r, scope);
      switch (ast.op) {
        case "eq": return l === r;
        case "ne": return l !== r;
        case "lt": case "le": case "gt": case "ge": {
          if (typeof l !== "number" || typeof r !== "number") throw new Error(`"${ast.op}" needs numeric operands`);
          return ast.op === "lt" ? l < r : ast.op === "le" ? l <= r : ast.op === "gt" ? l > r : l >= r;
        }
        case "+": case "-": return numOp(ast.op, l, r);
        default: throw new Error(`Unknown operator "${ast.op}"`);
      }
    }
  }
}

function numOp(op: "+" | "-", l: unknown, r: unknown): number {
  if (typeof l !== "number" || typeof r !== "number") throw new Error(`"${op}" needs numeric operands`);
  return op === "+" ? l + r : l - r;
}

export function truthy(v: unknown): boolean { return Boolean(v); }

/** Compile once, evaluate many times. Malformed expressions throw immediately. */
export function compileCondition(src: string): (scope: ExprScope) => boolean {
  const ast = parse(src); // syntax errors surface at save time
  return (scope) => truthy(evaluate(ast, scope));
}

/** Convenience: parse + evaluate in one call. */
export function evaluateExpression(src: string, scope: ExprScope): unknown {
  return evaluate(parse(src), scope);
}
