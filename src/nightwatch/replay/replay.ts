import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Notice } from '../domain/models.ts';

const DEFAULT_NOTICE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'notices');

type JsonRecord = Record<string, unknown>;

interface ParsedNotice {
  notice: Notice;
  recordNumber: number;
}

function normalizedVersion(recordNumber: number): number {
  // These are the record numbers in the real replay pair. Keep the mapping
  // explicit at the single-payload boundary; the directory loader reindexes
  // any ordered set to 1, 2, ... below.
  if (recordNumber === 3) return 1;
  if (recordNumber === 6) return 2;
  return recordNumber;
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredField(raw: JsonRecord, field: string): unknown {
  const value = raw[field];
  if (value === undefined) {
    throw new Error(`GCN notice is missing required field ${field}`);
  }
  return value;
}

function requiredNumber(raw: JsonRecord, field: string): number {
  const value = requiredField(raw, field);
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`GCN notice field ${field} must be a finite number`);
  }
  return value;
}

function requiredString(raw: JsonRecord, field: string): string {
  const value = requiredField(raw, field);
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`GCN notice field ${field} must be a non-empty string`);
  }
  return value;
}

function eventIdFrom(raw: JsonRecord): string {
  const value = requiredField(raw, 'id');
  if (!Array.isArray(value) || value.length === 0 || value.some((id) => typeof id !== 'string')) {
    throw new Error('GCN notice field id must be a non-empty array of strings');
  }

  const designation = value.find((id) => /^bn/i.test(id));
  if (designation === undefined) {
    throw new Error('GCN notice id array has no bn designation');
  }
  return designation;
}

function receivedAtFrom(raw: JsonRecord): Date {
  const value = requiredString(raw, 'alert_datetime');
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/.exec(value);
  if (!match) {
    throw new Error('GCN notice field alert_datetime must be an ISO timestamp without a timezone');
  }

  // GCN alert_datetime has no zone suffix. Append Z so this is always UTC,
  // regardless of the machine's local timezone.
  const date = new Date(`${value}Z`);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`GCN notice field alert_datetime is invalid: ${value}`);
  }

  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() + 1 !== month
    || date.getUTCDate() !== day
    || date.getUTCHours() !== hour
    || date.getUTCMinutes() !== minute
    || date.getUTCSeconds() !== second
  ) {
    throw new Error(`GCN notice field alert_datetime is invalid: ${value}`);
  }

  return date;
}

function parseGcn(raw: unknown): ParsedNotice {
  if (!isJsonRecord(raw)) {
    throw new Error('GCN notice payload must be a JSON object');
  }

  const recordNumber = requiredNumber(raw, 'record_number');
  if (!Number.isInteger(recordNumber) || recordNumber < 1) {
    throw new Error('GCN notice field record_number must be a positive integer');
  }

  const raDeg = requiredNumber(raw, 'ra');
  const decDeg = requiredNumber(raw, 'dec');
  const errorRadiusDeg = requiredNumber(raw, 'ra_dec_error');
  if (raDeg < 0 || raDeg > 360) {
    throw new Error('GCN notice field ra must be between 0 and 360 degrees');
  }
  if (decDeg < -90 || decDeg > 90) {
    throw new Error('GCN notice field dec must be between -90 and 90 degrees');
  }
  if (errorRadiusDeg < 0) {
    throw new Error('GCN notice field ra_dec_error must not be negative');
  }

  return {
    recordNumber,
    notice: {
      eventId: eventIdFrom(raw),
      // The source record number is the ordering signal. loadReplayNotices()
      // normalizes that ordering to the domain's compact 1, 2, ... versions.
      version: normalizedVersion(recordNumber),
      raDeg,
      decDeg,
      errorRadiusDeg,
      receivedAt: receivedAtFrom(raw),
      // Keep the original parsed payload object. Do not clone or mutate it.
      raw,
    },
  };
}

export function noticeFromGcn(raw: unknown): Notice {
  return parseGcn(raw).notice;
}

export function loadReplayNotices(dir?: string): Notice[] {
  const noticeDir = dir ?? DEFAULT_NOTICE_DIR;
  const parsed = readdirSync(noticeDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((entry): ParsedNotice => {
      const raw = JSON.parse(readFileSync(join(noticeDir, entry.name), 'utf8')) as unknown;
      return parseGcn(raw);
    })
    .sort((a, b) => a.recordNumber - b.recordNumber || a.notice.receivedAt.getTime() - b.notice.receivedAt.getTime());

  return parsed.map(({ notice }, index) => ({
    ...notice,
    version: index + 1,
  }));
}
