import { z } from 'zod';
import { CliError } from './io.js';

const sinceSchema = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);

export function parseSince(value: string): Date {
  const result = sinceSchema.safeParse(value);
  if (!result.success) {
    throw new CliError(`--since must be an ISO date such as 2025-01-01, got "${value}".`);
  }
  return new Date(result.data);
}

export function parsePositiveInteger(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CliError(`${flag} must be a positive whole number, got "${value}".`);
  }
  return parsed;
}
