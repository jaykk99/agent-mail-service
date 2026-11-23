'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = process.env.APP_ROOT || '/app';
const files = [];
function visit(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) visit(full);
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(full);
  }
}
visit(root);
assert.ok(files.includes(path.join(root, 'server.js')), 'server.js missing from image');
let checked = 0;
for (const file of files) {
  const source = fs.readFileSync(file, 'utf8');
  const imports = [...source.matchAll(/\\brequire\\s*\\(\\s*['"]([.][^'"]+)['"]\\s*\\)/g)];
  for (const match of imports) {
    const target = match[1];
    assert.doesNotThrow(
      () => require.resolve(path.resolve(path.dirname(file), target)),
      `missing packaged relative import ${target} from ${path.relative(root, file)}`
    );
    checked++;
  }
}
assert.ok(checked > 0, 'expected relative imports to verify');
console.log(`PASS: resolved ${checked} relative imports across ${files.length} packaged JS files`);
