// Usage: php wordpress/tests/helpers.php /tmp/pbin-templates.json &&
// node wordpress/tests/template-syntax.cjs /tmp/pbin-templates.json
const fs = require('node:fs');
const vm = require('node:vm');
const pages = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
let total = 0;
for (const [name, html] of Object.entries(pages)) {
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/\bsrc=/.test(match[1]) || !match[2].trim()) continue;
    new vm.Script(match[2], {filename: name + '-inline-' + (++total) + '.js'});
  }
}
console.log(`PASS: ${total} generated inline JavaScript blocks parse`);
