/**
 * The demo's timing is part of its argument, so it is tested like the rest.
 *
 * This exists because it broke once: the revision landed exactly as the slew
 * finished, the post-slew consent check passed a fraction too early, the
 * exposure fired, and the thread then said no telescope action had been taken
 * while a completed observation sat directly above it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { REVISION_AFTER_SLEW_MS, SIMULATOR_STEP_MS } from "./nightwatch";

test("the revision lands while the mount is still slewing", () => {
  assert.ok(
    REVISION_AFTER_SLEW_MS < SIMULATOR_STEP_MS,
    `revision at ${REVISION_AFTER_SLEW_MS}ms must land inside the ${SIMULATOR_STEP_MS}ms slew`,
  );
});

test("it lands with real margin, not on the boundary", () => {
  assert.ok(
    REVISION_AFTER_SLEW_MS <= SIMULATOR_STEP_MS / 2,
    "leave at least half the slew after the revision, so scheduling jitter cannot let the exposure through",
  );
});
