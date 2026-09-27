import Link from 'next/link';

export default function NotFound() {
  return (
    <main id="main" className="mx-auto mt-24 max-w-lg px-4">
      <p className="font-mono text-2xs uppercase tracking-[0.18em] text-inferred">404</p>
      <h1 className="mt-2 text-xl font-semibold">Nothing indexed here</h1>
      <p className="mt-2 text-sm text-muted">
        The page names a repository, file or symbol the index does not have.
      </p>
      <Link href="/" className="mt-4 inline-block text-sm text-accent hover:underline">
        Back to repositories
      </Link>
    </main>
  );
}
