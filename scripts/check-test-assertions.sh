#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
audit=$(mktemp -d)
trap 'rm -rf "$audit"' EXIT
npm install --prefix "$audit" --ignore-scripts --no-audit --no-fund typescript@5.9.3 >/dev/null
AUDIT_PARSER="$audit/node_modules/typescript" node --input-type=commonjs - "$@" <<'JS'
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const ts = require(process.env.AUDIT_PARSER);
const base = '7a240528980f386f87f93c90d1078c2c9df253eb';
const mappings = JSON.parse(fs.readFileSync('scripts/test-assertion-mappings.json', 'utf8'));
const suites = ['fixture-isolation', 'transport', 'link-guard', 'startup', 'launch-race', 'adapter', 'selection', 'retirement', 'claude'];
const printer = ts.createPrinter({ removeComments: true });
function inventory(file, text) {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const print = node => printer.printNode(ts.EmitHint.Unspecified, node, source);
  const entries = [];
  entries.tableLoops = [];
  const tables = new Map();
  function collectTables(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      let value = node.initializer;
      while (ts.isAsExpression(value) || ts.isSatisfiesExpression(value) || ts.isParenthesizedExpression(value)) value = value.expression;
      if (ts.isArrayLiteralExpression(value) && value.elements.length) tables.set(node.name.text, print(node.initializer));
    }
    ts.forEachChild(node, collectTables);
  }
  collectTables(source);
  function visit(node, loops = [], title = '', domains = []) {
    if (ts.isFunctionDeclaration(node) && node.name) title = `shared fixture ${node.name.text}`;
    if (ts.isForOfStatement(node)) {
      const header = `for (${print(node.initializer)} of ${print(node.expression)})`;
      loops = [...loops, header];
      let values = node.expression;
      while (ts.isAsExpression(values) || ts.isSatisfiesExpression(values) || ts.isParenthesizedExpression(values)) values = values.expression;
      if (ts.isArrayLiteralExpression(values)) entries.tableLoops.push(header);
      if (ts.isIdentifier(node.expression) && tables.has(node.expression.text)) {
        domains = [...domains, [node.expression.text, tables.get(node.expression.text)]];
        entries.tableLoops.push(`${header}: ${tables.get(node.expression.text)}`);
      }
    }
    if (ts.isForStatement(node)) loops = [...loops, `for (${node.initializer && print(node.initializer)}; ${node.condition && print(node.condition)}; ${node.incrementor && print(node.incrementor)})`];
    if (ts.isCallExpression(node)) {
      const expression = node.expression.getText(source);
      if (expression === 'test') title = node.arguments[0]?.getText(source) ?? title;
      if (expression === 'assert' || expression.startsWith('assert.')) entries.push({ expression: print(node), loops, domains, file, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, title });
    }
    if (ts.isThrowStatement(node)) entries.push({ expression: print(node), loops, domains, file, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, title });
    ts.forEachChild(node, child => visit(child, loops, title, domains));
  }
  visit(source);
  return entries;
}
const baseline = {};
for (const suite of suites) {
  const oldFile = `${suite}-check.ts`;
  const oldText = execFileSync('git', ['show', `${base}:${oldFile}`], { encoding: 'utf8' });
  const before = inventory(oldFile, oldText);
  baseline[suite] = before;
  const files = fs.existsSync(oldFile) ? [oldFile] : [`${suite}.test.ts`, ...(mappings[suite]?.helpers ?? [])];
  const inventories = files.map(file => inventory(file, fs.readFileSync(file, 'utf8')));
  const after = inventories.flat();
  const tableLoops = inventories.flatMap(entries => entries.tableLoops);
  for (const domain of before.tableLoops) {
    const expected = mappings[suite]?.loops?.find(item => item.before === domain)?.after ?? domain;
    const index = tableLoops.indexOf(expected);
    assert.notEqual(index, -1, `${suite}: missing table domain, including calls into assertion helpers: ${expected}`);
    tableLoops.splice(index, 1);
  }
  const remaining = [...after];
  for (const entry of before) {
    const adaptation = mappings[suite]?.expressions?.find(item => item.before === entry.expression);
    const expression = adaptation?.after ?? entry.expression;
    const loops = entry.loops.map(loop => mappings[suite]?.loops?.find(item => item.before === loop)?.after ?? loop);
    const index = remaining.findIndex(item => item.expression === expression && JSON.stringify(item.loops) === JSON.stringify(loops) && JSON.stringify(item.domains) === JSON.stringify(entry.domains));
    assert.notEqual(index, -1, `${suite}:${entry.line} missing assertion or loop domain\n${expression}\n${JSON.stringify(loops)}`);
    const [destination] = remaining.splice(index, 1);
    if (process.argv.includes('--locations')) console.log(`${oldFile}:${entry.line} -> ${destination.file}:${destination.line} ${destination.title}`);
  }
  for (const adaptation of mappings[suite]?.expressions ?? []) {
    assert(before.some(entry => entry.expression === adaptation.before), `stale adaptation in ${suite}: ${adaptation.before}`);
    assert(adaptation.reason, `adaptation needs a reason in ${suite}`);
  }
  if (suite === 'claude') {
    const source = ts.createSourceFile(oldFile, oldText, ts.ScriptTarget.Latest, true);
    let executable;
    function findExecutable(node) {
      if (ts.isCallExpression(node) && node.expression.getText(source) === 'writeFileSync' && node.arguments[0]?.getText(source) === 'fakeClaude') executable = node.arguments[1];
      ts.forEachChild(node, findExecutable);
    }
    findExecutable(source);
    assert(ts.isTemplateExpression(executable) && executable.templateSpans.length === 1);
    assert.equal(executable.templateSpans[0].expression.getText(source), 'process.execPath');
    const generated = executable.templateSpans[0].literal.text.slice(1);
    if (!fs.existsSync(oldFile)) assert.equal(fs.readFileSync('test-support/fake-claude.cjs', 'utf8'), generated, 'generated fake-Claude program including all throwing validations');
  }
  console.log(`${suite}: preserved ${before.length} assertions/guards and enclosing loop domains; ${remaining.length} additional assertions/guards`);
}
if (process.argv.includes('--capture')) fs.writeFileSync('/tmp/piha-issue10/assertion-baseline.json', JSON.stringify(baseline, null, 2) + '\n');
console.log(`PASS assertion preservation against ${base}`);
JS
