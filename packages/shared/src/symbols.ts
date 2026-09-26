import { z } from 'zod';

/** Kinds of code symbols extracted from source files. */
export const SYMBOL_KINDS = [
  'function',
  'method',
  'class',
  'interface',
  'type',
  'enum',
  'variable',
  'property',
  'struct',
  'trait',
  'impl',
  'module',
] as const;
export const symbolKindSchema = z.enum(SYMBOL_KINDS);
export type SymbolKind = z.infer<typeof symbolKindSchema>;
