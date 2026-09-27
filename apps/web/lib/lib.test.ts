import { describe, expect, it } from 'vitest';
import { layoutGraph } from './graph-layout';
import { decideProxy, isLocalHost } from './proxy';

describe('layoutGraph', () => {
  const nodes = [
    { id: 'symbol:1', type: 'symbol', label: 'calculateVAT' },
    { id: 'commit:1', type: 'commit', label: 'abc Add VAT' },
    { id: 'pull_request:1', type: 'pull_request', label: 'PR #421' },
    { id: 'issue:1', type: 'issue', label: '#398' },
    { id: 'file:1', type: 'file', label: 'src/vat.ts' },
    { id: 'file:2', type: 'file', label: 'src/lonely.ts' },
  ];
  const edges = [
    { source: 'symbol:1', target: 'commit:1' },
    { source: 'pull_request:1', target: 'commit:1' },
    { source: 'issue:1', target: 'pull_request:1' },
    { source: 'file:1', target: 'symbol:1' },
  ];

  it('places nodes in columns by distance from the root', () => {
    const positions = layoutGraph(nodes, edges, 'symbol:1');
    const column = (id: string) => (positions.get(id)?.x ?? -1) / 300;
    expect(column('symbol:1')).toBe(0);
    expect(column('commit:1')).toBe(1);
    expect(column('file:1')).toBe(1);
    expect(column('pull_request:1')).toBe(2);
    expect(column('issue:1')).toBe(3);
    // Unconnected nodes go last.
    expect(column('file:2')).toBe(4);
  });

  it('orders a column by type, then label, centred on zero', () => {
    const positions = layoutGraph(nodes, edges, 'symbol:1');
    expect(positions.get('commit:1')?.y).toBe(-36);
    expect(positions.get('file:1')?.y).toBe(36);
  });

  it('is deterministic, and groups by type without a root', () => {
    expect(layoutGraph(nodes, edges, null)).toEqual(layoutGraph([...nodes].reverse(), edges, null));
    const positions = layoutGraph(nodes, edges, null);
    expect(positions.get('issue:1')?.x).toBeLessThan(positions.get('commit:1')?.x ?? 0);
  });
});

describe('decideProxy', () => {
  const base = { method: 'GET', host: 'localhost:3000', contentType: null };

  it('forwards the routes the UI needs', () => {
    expect(decideProxy({ ...base, segments: ['repositories', '1', 'files'] })).toEqual({
      ok: true,
      apiPath: '/api/repositories/1/files',
    });
    expect(
      decideProxy({
        ...base,
        method: 'POST',
        contentType: 'application/json; charset=utf-8',
        segments: ['repositories', '1', 'investigate'],
      }),
    ).toMatchObject({ ok: true });
  });

  it('refuses foreign hosts, forms, traversal and routes the UI does not use', () => {
    expect(
      decideProxy({ ...base, host: 'evil.example', segments: ['repositories'] }),
    ).toMatchObject({
      status: 403,
    });
    expect(
      decideProxy({
        ...base,
        method: 'POST',
        contentType: 'text/plain',
        segments: ['repositories', '1', 'query'],
      }),
    ).toMatchObject({ status: 415 });
    expect(decideProxy({ ...base, segments: ['repositories', '1', '..', 'x'] })).toMatchObject({
      status: 400,
    });
    expect(decideProxy({ ...base, segments: ['repositories', '1', 'files%2F..'] })).toMatchObject({
      status: 400,
    });
    // Indexing and connecting GitHub stay with the CLI.
    expect(
      decideProxy({
        ...base,
        method: 'POST',
        contentType: 'application/json',
        segments: ['repositories', '1', 'index'],
      }),
    ).toMatchObject({ status: 404 });
    expect(
      decideProxy({
        ...base,
        method: 'POST',
        contentType: 'application/json',
        segments: ['repositories', '1', 'providers', 'github', 'connect'],
      }),
    ).toMatchObject({ status: 404 });
  });
});

describe('isLocalHost', () => {
  it('accepts loopback names with or without a port', () => {
    for (const host of [
      'localhost',
      'localhost:3000',
      '127.0.0.1:3100',
      '[::1]:3000',
      'LOCALHOST',
    ]) {
      expect(isLocalHost(host)).toBe(true);
    }
  });

  it('rejects other names, including ones that merely start like loopback', () => {
    for (const host of [
      null,
      '',
      'evil.example',
      '127.0.0.1.evil.example',
      'localhost.evil.example:3000',
    ]) {
      expect(isLocalHost(host)).toBe(false);
    }
  });
});
