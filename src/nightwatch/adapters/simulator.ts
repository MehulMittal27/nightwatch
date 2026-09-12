/**
 * Simulated telescope. Deterministic on purpose.
 *
 * Every value it returns is derived from the request, so two runs of the demo
 * produce identical numbers and a rehearsal is worth something. Nothing here is
 * random and nothing here comes from a model.
 *
 * `simulated` is true and stays true. Every card that renders this must say
 * SIMULATED.
 */

import { createHash } from 'node:crypto';

import { type ObservationResult } from '../domain/models.ts';
import type { ExposeRequest, SlewRequest, TelescopeAdapter } from './telescope.ts';

export interface SimulatorOptions {
  id?: string;
  /** Wall-clock milliseconds per simulated step. 0 in tests, ~1200 for the demo. */
  stepMs?: number;
  /** Force a slew failure, to exercise the fall-back-to-next-site path. */
  failSlew?: boolean;
}

export class SimulatedTelescope implements TelescopeAdapter {
  readonly id: string;
  readonly simulated = true;
  readonly #stepMs: number;
  readonly #failSlew: boolean;
  #pointing: SlewRequest | null = null;

  constructor(options: SimulatorOptions = {}) {
    this.id = options.id ?? 'sim-teide-iac80';
    this.#stepMs = options.stepMs ?? 0;
    this.#failSlew = options.failSlew ?? false;
  }

  async slew(req: SlewRequest): Promise<void> {
    await this.#tick();
    if (this.#failSlew) {
      throw new Error(`${this.id} rejected the slew: target below mount limit`);
    }
    this.#pointing = req;
  }

  async expose(req: ExposeRequest): Promise<ObservationResult> {
    if (this.#pointing === null) {
      throw new Error(`${this.id} was commanded to expose before slewing`);
    }
    await this.#tick();

    const pointing = this.#pointing;
    // Deterministic jitter: the candidate lands a few arcseconds off the
    // commanded position, the same few arcseconds every run.
    const seed = hashToUnit(`${this.id}:${pointing.raDeg}:${pointing.decDeg}:${req.filter}`);
    const offsetDeg = (seed - 0.5) * 0.004;

    // SNR grows with the square root of total integration time. Plain physics,
    // computed here, never invented by a model.
    const totalSec = req.exposureSec * req.count;
    const snr = round(2.4 * Math.sqrt(totalSec), 1);
    const limitingMagnitude = round(18.2 + 1.25 * Math.log10(totalSec / 120), 2);

    return {
      candidateRaDeg: round(pointing.raDeg + offsetDeg, 6),
      candidateDecDeg: round(pointing.decDeg - offsetDeg, 6),
      snr,
      limitingMagnitude,
      imageRef: `simulated://${this.id}/${req.filter}/${req.count}x${req.exposureSec}s.fits`,
    };
  }

  async #tick(): Promise<void> {
    if (this.#stepMs > 0) await new Promise((r) => setTimeout(r, this.#stepMs));
  }
}

function hashToUnit(s: string): number {
  const hex = createHash('sha256').update(s).digest('hex').slice(0, 8);
  return parseInt(hex, 16) / 0xffffffff;
}

function round(v: number, places: number): number {
  const f = 10 ** places;
  return Math.round(v * f) / f;
}
