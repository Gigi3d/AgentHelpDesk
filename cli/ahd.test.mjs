import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, redact, statusOf, buildReport } from './ahd.mjs';

test('files for agent-facing errors, not for success, interrupts or plain typos', () => {
  assert.equal(classify(1, '', 'Error: request failed with status 401 Unauthorized'), 'http status');
  assert.equal(classify(1, '', 'unknown flag: --regoin'), 'unknown or removed surface');
  assert.equal(classify(0, '', '401 Unauthorized'), null);
  assert.equal(classify(130, '', '401 Unauthorized'), null);
  assert.equal(classify(1, '', 'something odd happened'), null);
});

test('secrets never leave the machine in a report', () => {
  const r = redact('x-api-key: sk-ant-abcdefghijklmnop and Authorization: Bearer abcdefghijklmnop1234 and bl_aaab3q4zzzzzzzz');
  assert.ok(!/abcdefghijklmnop/.test(r));
  assert.ok(!/zzzzzzzz/.test(r));
});

test('the report carries the status and a redacted command', () => {
  assert.equal(statusOf('GET /v1/x returned 429 slow down'), 429);
  const rep = buildReport({ argv: ['bl', 'deploy', '--token', 'abc12345678'], code: 1, stdout: '', stderr: 'HTTP/1.1 403 Forbidden', why: 'http status', vendor: 'blaxel', agent: 'a' });
  assert.equal(rep.vendor_hint, 'blaxel');
  assert.equal(rep.response.http_status, 403);
  assert.match(rep.task, /redacted/);
});
