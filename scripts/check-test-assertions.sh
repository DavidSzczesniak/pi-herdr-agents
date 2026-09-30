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
  function visit(node, loops = [], title = '') {
    if (ts.isForOfStatement(node)) loops = [...loops, `for (${print(node.initializer)} of ${print(node.expression)})`];
    if (ts.isForStatement(node)) loops = [...loops, `for (${node.initializer && print(node.initializer)}; ${node.condition && print(node.condition)}; ${node.incrementor && print(node.incrementor)})`];
    if (ts.isCallExpression(node)) {
      const expression = node.expression.getText(source);
      if (expression === 'test') title = node.arguments[0]?.getText(source) ?? title;
      if (expression === 'assert' || expression.startsWith('assert.')) entries.push({ expression: print(node), loops, file, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, title });
    }
    ts.forEachChild(node, child => visit(child, loops, title));
  }
  visit(source);
  return entries;
}
for (const suite of suites) {
  const oldFile = `${suite}-check.ts`;
  const oldText = execFileSync('git', ['show', `${base}:${oldFile}`], { encoding: 'utf8' });
  const before = inventory(oldFile, oldText);
  const files = fs.existsSync(oldFile) ? [oldFile] : [`${suite}.test.ts`, ...(mappings[suite]?.helpers ?? [])];
  const after = files.flatMap(file => inventory(file, fs.readFileSync(file, 'utf8')));
  const remaining = [...after];
  for (const entry of before) {
    const adaptation = mappings[suite]?.expressions?.find(item => item.before === entry.expression);
    const expression = adaptation?.after ?? entry.expression;
    const loops = entry.loops.map(loop => mappings[suite]?.loops?.find(item => item.before === loop)?.after ?? loop);
    const index = remaining.findIndex(item => item.expression === expression && JSON.stringify(item.loops) === JSON.stringify(loops));
    assert.notEqual(index, -1, `${suite}:${entry.line} missing assertion or loop domain\n${expression}\n${JSON.stringify(loops)}`);
    const [destination] = remaining.splice(index, 1);
    if (process.argv.includes('--locations')) console.log(`${oldFile}:${entry.line} -> ${destination.file}:${destination.line} ${destination.title}`);
  }
  for (const adaptation of mappings[suite]?.expressions ?? []) {
    assert(before.some(entry => entry.expression === adaptation.before), `stale adaptation in ${suite}: ${adaptation.before}`);
    assert(adaptation.reason, `adaptation needs a reason in ${suite}`);
  }
  if (suite === 'claude') {
    const template = oldText.slice(oldText.indexOf('writeFileSync(fakeClaude,'), oldText.indexOf('chmodSync(fakeClaude'));
    if (fs.existsSync(oldFile)) assert(fs.readFileSync(oldFile, 'utf8').includes(template));
    else assert(files.some(file => fs.readFileSync(file, 'utf8').includes(template)), 'generated fake-Claude validations changed');
  }
  console.log(`${suite}: preserved ${before.length} assertion expressions and enclosing loop domains; ${remaining.length} additional assertions`);
}
console.log(`PASS assertion preservation against ${base}`);
JS
