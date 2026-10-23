import { createHash } from "node:crypto";
import { parse } from "acorn";

export const digest = value => createHash("sha256").update(value).digest("hex");
const fail = code => { throw new Error(code); };
const plain = value => value && typeof value === "object" && !Array.isArray(value);
const exact = (value, keys) => plain(value) && Object.keys(value).every(key => keys.includes(key));
const sensitive = /auth|permission|session|password|cookie|token|secret|credential|wallet|loan|credit|contract|commission|payment|balance|ledger|funding|deduction|collateral|financial|mutat|insert|delete|update|identity|national|username|customer|salesperson|assignee|ownerId|userId|staff|expert|phone|mobile|\brole\b|\bid\b|\botp\b|\badmin\b|certificate|signatur|money|amount|interest|installment|principal|\brank\b|قسط|وام|مبلغ|تومان|ریال|سود|مجوز|هویت|دسترسی|\.save\b|\.remove\b|fetch|axios|XMLHttpRequest|WebSocket|sendBeacon|require\s*\(|import\s*\(|process\.|globalThis|window\.|document\.|localStorage|sessionStorage|constructor|prototype|__proto__|eval\b|https?:|javascript:|data:|\/api\//i;
const properties = new Set(("width min-width max-width height min-height max-height margin margin-top margin-bottom margin-left margin-right padding padding-top padding-bottom padding-left padding-right gap row-gap column-gap overflow overflow-x overflow-y box-sizing display flex flex-direction flex-wrap flex-grow flex-shrink flex-basis align-items align-content align-self justify-content grid-template-columns grid-template-rows white-space word-break overflow-wrap text-align line-height font-size border-radius").split(" "));
const safeValue = /^[a-zA-Z0-9#(),.%+\- /!]+$/;

export function cssRule(source) {
  const matched = /^(\.[a-zA-Z][a-zA-Z0-9_ .,:>+~#()\-]*)\s*\{([^{}]*)\}\s*$/.exec(source.trim());
  if (!matched || /(?:url|expression|attr|image|javascript|@|\\)/i.test(source)) fail("unsupported_css_rule");
  if (/(?:auth|login|permission|password|wallet|loan|credit|contract|commission|payment|balance|invoice|cheque|promissory)/i.test(matched[1]) ||
      /(?:^|[ .>,+~])(?:hidden|sr-only|invisible)(?:$|[ .>,+~])/.test(matched[1]))
    fail("sensitive_css_selector");
  const values = {};
  for (const item of matched[2].split(";").filter(item => item.trim())) {
    const declaration = /^\s*([a-z-]+)\s*:\s*(.*?)\s*$/.exec(item);
    if (!declaration || !safeValue.test(declaration[2]) ||
        declaration[2].length > 120 || declaration[1] in values) fail("unsafe_css_declaration");
    values[declaration[1]] = declaration[2];
  }
  if (!Object.keys(values).length) fail("empty_css_rule");
  return { selector: matched[1].trim(), values };
}

function walk(node, visit) {
  if (!node || typeof node !== "object") return;
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === "start" || key === "end") continue;
    if (Array.isArray(value)) value.forEach(child => walk(child, visit));
    else if (value && typeof value === "object") walk(value, visit);
  }
}

function functionShape(source) {
  if (sensitive.test(source)) fail("sensitive_or_effectful_function");
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "module" });
  if (ast.body.length !== 1 || ast.body[0].type !== "FunctionDeclaration" ||
      !ast.body[0].id || ast.body[0].async || ast.body[0].generator) fail("standalone_function_required");
  const fn = ast.body[0], identifiers = new Set(), calls = new Set();
  const bound = new Set([fn.id.name]), globals = new Set(["String", "Number", "Boolean", "Math", "JSON", "Array", "Object", "NaN", "Infinity", "undefined"]);
  const pureCalls = /^(?:String|Number|Boolean|(?:Math\.(?:min|max|round|floor|ceil|abs|trunc|sign|pow))|(?:JSON\.(?:parse|stringify))|(?:Object\.(?:keys|values|entries))|(?:Array\.(?:isArray|from))|[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\.(?:slice|substring|substr|trim|trimStart|trimEnd|replace|replaceAll|includes|indexOf|lastIndexOf|startsWith|endsWith|toLowerCase|toUpperCase|charAt|charCodeAt|split|join|toString|toFixed|toLocaleString))$/;
  if (fn.params.some(param => param.type !== "Identifier")) fail("simple_pure_parameters_required");
  fn.params.forEach(param => bound.add(param.name));
  walk(fn, node => {
    if (node !== fn && ["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(node.type))
      fail("nested_function_not_allowed");
    if (node.type === "VariableDeclarator") {
      if (node.id.type !== "Identifier") fail("simple_pure_bindings_required");
      bound.add(node.id.name);
    }
  });
  walk(fn, node => {
    if (["NewExpression", "ImportExpression", "AwaitExpression", "YieldExpression", "ThisExpression",
      "WhileStatement", "DoWhileStatement", "ForStatement", "ForInStatement", "ForOfStatement",
      "WithStatement", "ThrowStatement", "TryStatement", "DebuggerStatement",
      "AssignmentExpression", "UpdateExpression", "TaggedTemplateExpression"].includes(node.type))
      fail("unsupported_function_effect");
    if (node.type === "Identifier") {
      if (sensitive.test(node.name) || node.name === "Function") fail("unsafe_identifier");
      identifiers.add(node.name);
    }
    if (node.type === "CallExpression") {
      const callee = source.slice(node.callee.start, node.callee.end);
      if (!pureCalls.test(callee)) fail("non_pure_call");
      calls.add(callee);
    }
    if (node.type === "MemberExpression" && node.computed && node.property.type !== "Literal")
      fail("dynamic_member_not_allowed");
    if (node.type === "Literal" && typeof node.value === "string" &&
        (/^[\\/]/.test(node.value) || sensitive.test(node.value))) fail("unsafe_function_literal");
    if (node.type === "Literal" && node.regex) fail("regex_normalization_requires_review");
  });
  const references = node => {
    if (!node || typeof node !== "object") return;
    if (node.type === "Identifier" && !bound.has(node.name) && !globals.has(node.name))
      fail("external_function_binding");
    for (const [key, value] of Object.entries(node)) {
      if (key === "start" || key === "end" ||
          (node.type === "MemberExpression" && key === "property" && !node.computed) ||
          (node.type === "Property" && key === "key" && !node.computed)) continue;
      if (Array.isArray(value)) value.forEach(references);
      else if (value && typeof value === "object") references(value);
    }
  };
  references(fn);
  return { fn, identifiers, calls, name: fn.id.name, parameters: fn.params.map(param => source.slice(param.start, param.end)) };
}

function validateFunction(before, after) {
  const old = functionShape(before), next = functionShape(after);
  if (old.name !== next.name || JSON.stringify(old.parameters) !== JSON.stringify(next.parameters))
    fail("function_interface_changed");
  if ([...next.identifiers].some(name => !old.identifiers.has(name)) ||
      [...next.calls].some(name => !old.calls.has(name))) fail("new_function_capability");
  return old.name;
}

/** No model text is ever a shell command, SQL statement, URL or deployment path. */
export function applyRepair(files, recipe, identity) {
  if (!exact(recipe, ["format", "jobId", "baselineRelease", "baselineApiHash", "outcome", "reason", "edits", "checks"]) ||
      recipe.format !== 1 || recipe.jobId !== identity.jobId ||
      recipe.baselineRelease !== identity.baselineRelease || recipe.baselineApiHash !== identity.baselineApiHash)
    fail("repair_identity_mismatch");
  if (recipe.outcome !== "candidate") fail("agent_could_not_repair");
  if (!Array.isArray(recipe.edits) || recipe.edits.length < 1 || recipe.edits.length > 6 ||
      !Array.isArray(recipe.checks) || recipe.checks.length < 1 || recipe.checks.length > 20)
    fail("bounded_edits_and_checks_required");
  const output = new Map(files), changes = [], targets = new Set();
  for (const edit of recipe.edits) {
    if (!exact(edit, ["file", "fileSha256", "before", "after"]) ||
        typeof edit.file !== "string" || targets.has(edit.file) ||
        !/^(?:public\/assets\/[A-Za-z0-9_.-]+\.(?:css|js)|artifacts\/api-server\/dist\/index\.mjs)$/.test(edit.file) ||
        typeof edit.before !== "string" || typeof edit.after !== "string" ||
        edit.before.length < 5 || edit.before.length > 32_000 || edit.after.length > 32_000 ||
        edit.before === edit.after) fail("unsupported_edit");
    targets.add(edit.file);
    const original = files.get(edit.file);
    if (typeof original !== "string" || digest(original) !== edit.fileSha256)
      fail("source_file_hash_mismatch");
    const start = original.indexOf(edit.before);
    if (start < 0 || original.indexOf(edit.before, start + 1) >= 0) fail("unique_anchor_required");
    let kind, name;
    if (edit.file.endsWith(".css")) {
      const old = cssRule(edit.before), next = cssRule(edit.after);
      if (old.selector !== next.selector) fail("css_selector_changed");
      for (const property of new Set([...Object.keys(old.values), ...Object.keys(next.values)]))
        if (old.values[property] !== next.values[property] && !properties.has(property)) fail("unsafe_css_property_change");
      kind = "css"; name = old.selector;
    } else {
      name = validateFunction(edit.before, edit.after); kind = "function";
      const ast = parse(original, { ecmaVersion: "latest", sourceType: "module" });
      let anchored = false;
      walk(ast, node => {
        if (node.type === "FunctionDeclaration" && node.start === start && node.end === start + edit.before.length) anchored = true;
      });
      if (!anchored) fail("whole_function_anchor_required");
    }
    const patched = original.slice(0, start) + edit.after + original.slice(start + edit.before.length);
    if (patched.slice(0, start) + edit.before + patched.slice(start + edit.after.length) !== original)
      fail("unrelated_bytes_changed");
    if (kind === "function") parse(patched, { ecmaVersion: "latest", sourceType: "module" });
    output.set(edit.file, patched);
    changes.push({ file: edit.file, kind, name, before: edit.before, after: edit.after });
  }
  let demonstrated = false;
  const evaluations = [], functionTests = [];
  for (const check of recipe.checks) {
    if (!plain(check)) fail("invalid_check");
    const change = changes.find(change => change.file === check.file);
    if (!change) fail("check_outside_changed_files");
    if (change.kind === "css") {
      if (!exact(check, ["kind", "file", "selector", "property", "expected"]) ||
          check.kind !== "css" || check.selector !== change.name ||
          typeof check.expected !== "string" || !properties.has(check.property))
        fail("invalid_css_check");
      const before = cssRule(change.before), after = cssRule(change.after);
      if (after.values[check.property] !== check.expected) fail("candidate_css_check_failed");
      if (before.values[check.property] !== check.expected) demonstrated = true;
      evaluations.push({ name: `css:${check.selector}:${check.property}`, passed: true });
    } else {
      if (!exact(check, ["kind", "file", "function", "args", "expected"]) ||
          check.kind !== "function" || check.function !== change.name ||
          !Array.isArray(check.args) || JSON.stringify(check).length > 4096)
        fail("invalid_function_check");
      functionTests.push({ ...check, before: change.before, after: change.after });
    }
  }
  if (changes.some(change => !recipe.checks.some(check => check.file === change.file)))
    fail("untested_change");
  if (!demonstrated && !functionTests.length) fail("no_demonstrated_regression");
  return { output, changes, evaluations, functionTests, demonstrated };
}

/** Exact, eligible code units, not a relabelled development checkout or runtime data. */
export function projectSource(files) {
  const projected = [];
  for (const [file, text] of files) {
    const units = [];
    if (file.endsWith(".css")) {
      for (const match of text.matchAll(/[^{}]+\{[^{}]*\}/g)) {
        const source = match[0].trim();
        if (source.length > 32_000) continue;
        try {
          const rule = cssRule(source);
          if (Object.keys(rule.values).some(property => properties.has(property))) units.push(source);
        } catch {}
      }
    } else {
      const ast = parse(text, { ecmaVersion: "latest", sourceType: "module" });
      walk(ast, node => {
        if (node.type !== "FunctionDeclaration" || node.end - node.start > 32_000) return;
        const source = text.slice(node.start, node.end);
        if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}|\b0?9\d{9}\b/i.test(source)) return;
        try { functionShape(source); units.push(source); } catch {}
      });
    }
    if (units.length) projected.push({ file, fileSha256: digest(text), units: [...new Set(units)] });
  }
  return projected;
}
