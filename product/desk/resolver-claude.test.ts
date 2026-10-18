import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAnswer, unifiedDiff, validateCandidate } from './resolver-claude.ts';

const reply = (file: string): string =>
  `<fix_steps>\n- Send Authorization: Bearer\n- Retry\n</fix_steps>\n<snippet>\ncurl -H "Authorization: Bearer $K" https://x\n</snippet>\n<file>\n${file}\n</file>`;

test('parseAnswer extracts steps, snippet and the complete file', () => {
  const p = parseAnswer(reply('# Doc\nline'));
  assert.deepEqual(p.fix_steps, ['Send Authorization: Bearer', 'Retry']);
  assert.match(p.snippet, /^curl /);
  assert.equal(p.file, '# Doc\nline\n');
});

test('parseAnswer rejects a reply without the required blocks', () => {
  assert.throws(() => parseAnswer('just prose'), /did not contain/);
});

test('parseAnswer unwraps a single code fence around the file', () => {
  assert.equal(parseAnswer(reply('```md\nA\nB\n```')).file, 'A\nB\n');
});

test('unifiedDiff shows only changed hunks with context and is empty when unchanged', () => {
  const a = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'].join('\n');
  const b = a.replace('5', 'FIVE');
  const d = unifiedDiff('docs/x.md', a, b);
  assert.match(d, /^--- a\/docs\/x.md\n\+\+\+ b\/docs\/x.md\n@@ /);
  assert.match(d, /-5\n\+FIVE/);
  assert.equal(unifiedDiff('x', a, a), '');
});

test('validateCandidate refuses unchanged, empty and key-looking output', () => {
  const ok = parseAnswer(reply('new'));
  assert.doesNotThrow(() => validateCandidate('old\n', ok));
  assert.throws(() => validateCandidate('new\n', ok), /unchanged/);
  assert.throws(() => validateCandidate('old', { ...ok, file: '  \n' }), /empty/);
  assert.throws(() => validateCandidate('old', { ...ok, file: 'sk_live_abcdefghijklmnop\n' }), /live key/);
});
