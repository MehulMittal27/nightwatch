/**
 * Site-coverage invariant.
 *
 * The demo requires that the human can approve the REVISED plan and get a
 * result back. That is only possible if some configured site can actually put
 * the revised position above its altitude limit.
 *
 * A revision that crosses the celestial equator takes every northern site out
 * at once, which turns the payoff of the demo into a stand-down. This test
 * fails loudly at build time instead of at 13:45.
 *
 * The check is culmination geometry only - the highest altitude a target at
 * declination d can ever reach from latitude lat is 90 - |lat - d|. That is an
 * upper bound, so passing here does not promise a window tonight; FAILING here
 * promises there can never be one. Real windows are computed by the science
 * layer with astronomy-engine.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SITES } from './fixtures.ts';

const NOTICE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'replay', 'notices');

/** Highest altitude a target at this declination can ever reach from this site. */
function maxAltitudeDeg(latDeg: number, decDeg: number): number {
  return 90 - Math.abs(latDeg - decDeg);
}

function observableSites(decDeg: number): string[] {
  return SITES.filter((s) => maxAltitudeDeg(s.latDeg, decDeg) > s.altitudeLimitDeg).map((s) => s.id);
}

function replayNotices(): { file: string; ra: number; dec: number }[] {
  return readdirSync(NOTICE_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((file) => {
      const raw = JSON.parse(readFileSync(join(NOTICE_DIR, file), 'utf8')) as Record<string, unknown>;
      return { file, ra: raw['ra'] as number, dec: raw['dec'] as number };
    });
}

test('the site set spans both hemispheres', () => {
  assert.ok(SITES.some((s) => s.latDeg > 0), 'need a northern site');
  assert.ok(SITES.some((s) => s.latDeg < 0), 'need a southern site');
});

test('every replayed notice is observable from at least one configured site', () => {
  const notices = replayNotices();
  assert.ok(notices.length >= 2, 'replay needs at least a v1 and its revision');

  for (const n of notices) {
    const sites = observableSites(n.dec);
    assert.ok(
      sites.length > 0,
      `${n.file} at dec ${n.dec} clears no site's altitude limit - approving the revision could never return a result`,
    );
  }
});

test('the revision genuinely changes which sites can observe', () => {
  const notices = replayNotices().sort((a, b) => a.file.localeCompare(b.file));
  const first = notices.at(0);
  const last = notices.at(-1);
  assert.ok(first && last);

  const before = new Set(observableSites(first.dec));
  const after = observableSites(last.dec);

  assert.ok(
    after.some((id) => !before.has(id)) || after.length !== before.size,
    'the revision must change the observing picture, or there is nothing to repoint to',
  );
});
