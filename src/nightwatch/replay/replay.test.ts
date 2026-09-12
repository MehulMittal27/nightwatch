import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadReplayNotices, noticeFromGcn } from './replay.ts';

const NOTICE_DIR = fileURLToPath(new URL('./notices/', import.meta.url));
const V1_FILE = 'fermi-gbm-bn240812094-v1.json';

function readNotice(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(NOTICE_DIR, file), 'utf8')) as Record<string, unknown>;
}

test('loads the real GCN pair and normalizes versions in arrival order', () => {
  const notices = loadReplayNotices();

  assert.equal(notices.length, 2);
  assert.equal(notices[0]?.eventId, 'bn240812094');
  assert.equal(notices[0]?.version, 1);
  assert.equal(notices[1]?.eventId, 'bn240812094');
  assert.equal(notices[1]?.version, 2);
  assert.ok(notices[1]?.receivedAt.getTime() > notices[0]?.receivedAt.getTime());
});

test('parses alert_datetime as UTC and preserves raw payload unchanged', () => {
  const raw = readNotice(V1_FILE);
  const notice = noticeFromGcn(raw);

  assert.strictEqual(notice.raw, raw);
  assert.equal(notice.version, 1);
  assert.equal(notice.receivedAt.getTime(), Date.parse('2024-08-24T02:15:03Z'));
  assert.deepEqual(notice.raw, JSON.parse(JSON.stringify(raw)));
});

test('throws when a required coordinate is missing', () => {
  const raw = readNotice(V1_FILE);
  delete raw.ra;

  assert.throws(() => noticeFromGcn(raw), /ra/);
});
