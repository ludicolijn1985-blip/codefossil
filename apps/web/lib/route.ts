import { notFound } from 'next/navigation';

/** Route segment ids are positive integers; anything else is a 404, never an API call. */
export function idParam(value: string): number {
  const id = Number(value);
  if (!/^[1-9]\d{0,15}$/.test(value) || !Number.isSafeInteger(id)) notFound();
  return id;
}

/** A single string from a search param, ignoring repeats. */
export function oneParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
