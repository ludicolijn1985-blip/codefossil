import { API_URL, ApiRequestError, ApiUnavailableError } from '@/lib/api';

/**
 * Show a failed API call as guidance rather than a crash. The most common
 * cause — the API is not running — gets the exact command to fix it.
 */
export function Problem({ error }: { error: unknown }) {
  if (error instanceof ApiUnavailableError) {
    return (
      <div className="mx-auto mt-24 max-w-lg rounded-[var(--radius-panel)] border border-line bg-surface p-6">
        <p className="font-mono text-2xs uppercase tracking-[0.18em] text-inferred">
          API not reachable
        </p>
        <h1 className="mt-2 text-xl font-semibold">Start the CODEFOSSIL API</h1>
        <p className="mt-3 text-sm text-muted">
          This UI reads from <span className="font-mono text-ink">{API_URL}</span>. In the
          repository you want to explore, run:
        </p>
        <pre className="mt-3 rounded-md border border-line bg-ground px-3 py-2 font-mono text-sm">
          codefossil init{'\n'}codefossil index{'\n'}codefossil serve
        </pre>
      </div>
    );
  }
  const message = error instanceof ApiRequestError ? error.message : 'Something went wrong.';
  const code = error instanceof ApiRequestError ? error.code : 'error';
  return (
    <div
      role="alert"
      className="rounded-[var(--radius-panel)] border border-danger/40 bg-surface p-4"
    >
      <p className="font-mono text-2xs uppercase tracking-[0.18em] text-danger">{code}</p>
      <p className="mt-1 text-sm">{message}</p>
    </div>
  );
}
