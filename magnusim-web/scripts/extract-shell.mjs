import { readFileSync, writeFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const start = html.search(/<body\b/i);
const bodyOpenEnd = html.indexOf('>', start);
const end = html.lastIndexOf('</body>');
if (start < 0 || bodyOpenEnd < 0 || end < 0) throw new Error('index.html body not found');
const inner = html
  .slice(bodyOpenEnd + 1, end)
  .replace(/<script\b[\s\S]*?<\/script>/gi, '')
  .trim();
writeFileSync(new URL('../src/app/shell.html', import.meta.url), `${inner}\n`);
console.log(`wrote src/app/shell.html (${inner.length} chars)`);
