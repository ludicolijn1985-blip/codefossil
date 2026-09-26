import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readBlobs, type BlobRequest } from './blobs.js';
import { createSampleHistory, type SampleHistory } from './testing/index.js';

async function collect(
  root: string,
  requests: BlobRequest[],
  maxBytes?: number,
): Promise<(string | null)[]> {
  const out: (string | null)[] = [];
  for await (const result of readBlobs(
    root,
    requests,
    maxBytes === undefined ? {} : { maxBytes },
  )) {
    out.push(result.content?.toString('utf8') ?? null);
  }
  return out;
}

describe('readBlobs', () => {
  let sample: SampleHistory | undefined;

  beforeAll(async () => {
    sample = await createSampleHistory();
  });

  afterAll(async () => {
    await sample?.repo.cleanup();
  });

  const history = (): SampleHistory => {
    if (!sample) throw new Error('sample history was not created');
    return sample;
  };

  it('reads file contents at specific commits, in request order', async () => {
    const { repo, shas } = history();
    const contents = await collect(repo.root, [
      { revision: shas.reducedRate, path: 'src/payment/vat.ts' },
      { revision: shas.addVat, path: 'src/payment/vat.ts' },
      { revision: shas.addVat, path: 'README.md' },
    ]);
    expect(contents[0]).toContain('reduced ? 0.09 : 0.21');
    expect(contents[1]).toBe('export const calculateVAT = (n: number) => n * 0.21;\n');
    expect(contents[2]).toBe('# Shop\n');
  });

  it('returns null for missing paths, directories and unsendable paths without losing order', async () => {
    const { repo, shas } = history();
    const contents = await collect(repo.root, [
      { revision: shas.addVat, path: 'does/not/exist.ts' },
      { revision: shas.addVat, path: 'src' },
      { revision: shas.addVat, path: 'evil\nname.ts' },
      { revision: shas.addVat, path: 'README.md' },
    ]);
    expect(contents).toEqual([null, null, null, '# Shop\n']);
  });

  it('keeps binary content byte-exact', async () => {
    const { repo, shas } = history();
    for await (const { content } of readBlobs(repo.root, [
      { revision: shas.addLogo, path: 'assets/logo.png' },
    ])) {
      expect([...(content ?? [])]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]);
    }
  });

  it('skips blobs over the size limit but keeps reading the rest', async () => {
    const { repo, shas } = history();
    const contents = await collect(
      repo.root,
      [
        { revision: shas.reducedRate, path: 'src/payment/vat.ts' },
        { revision: shas.addVat, path: 'README.md' },
      ],
      10,
    );
    expect(contents).toEqual([null, '# Shop\n']);
  });

  it('fails cleanly, without an unhandled rejection, when git cannot start there', async () => {
    const missing = join(tmpdir(), 'codefossil-no-such-directory');
    await expect(collect(missing, [{ revision: 'HEAD', path: 'a.ts' }])).rejects.toThrow();
  });

  it('handles an empty request list', async () => {
    expect(await collect(history().repo.root, [])).toEqual([]);
  });
});
