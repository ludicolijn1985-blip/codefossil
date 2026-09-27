import {
  deleteEvidenceOfType,
  deleteFileImports,
  deleteRelationsByProducer,
  ensureFile,
  findDependency,
  findFileByPath,
  getGraphIndexedSha,
  listRepositoryImports,
  markDependenciesStale,
  recordEvidence,
  recordRelation,
  replaceFileImports,
  setGraphIndexedSha,
  setImportResolution,
  upsertDependency,
  type FossilDb,
  type RepositoryImport,
} from '@codefossil/db';
import { changedPaths, listHeadFiles, readBlobs } from '@codefossil/git';
import {
  createResolver,
  isManifestPath,
  ManifestParseError,
  parseManifest,
  type Manifest,
  type Resolution,
  minimumVersion,
} from '@codefossil/graph';
import { grammarForPath, SymbolExtractor, type ParsedImport } from '@codefossil/parser';
import { detectLanguage } from '@codefossil/shared';

export const IMPORT_RESOLVER_PRODUCER = 'import-resolver@0.1.0';
export const MANIFEST_READER_PRODUCER = 'manifest-reader@0.1.0';

export interface DependencyIndexResult {
  /** `unchanged` when HEAD is the snapshot already indexed. */
  readonly mode: 'full' | 'incremental' | 'unchanged';
  readonly filesParsed: number;
  readonly manifests: number;
  /** Manifests that could not be parsed, with the reason. */
  readonly manifestErrors: readonly string[];
  /**
   * Source files whose current version could not be parsed. Their earlier
   * imports are removed rather than kept, since nothing confirms they still
   * hold; these files contribute no edges until they parse again.
   */
  readonly parseFailures: readonly string[];
  readonly dependencies: number;
  readonly importEdges: number;
  readonly dependencyEdges: number;
  readonly builtinImports: number;
  readonly unresolvedImports: number;
}

const UNCHANGED: DependencyIndexResult = {
  mode: 'unchanged',
  filesParsed: 0,
  manifests: 0,
  manifestErrors: [],
  parseFailures: [],
  dependencies: 0,
  importEdges: 0,
  dependencyEdges: 0,
  builtinImports: 0,
  unresolvedImports: 0,
};

interface Snapshot {
  readonly headFiles: ReadonlySet<string>;
  /** Freshly parsed imports per path; null when the file could not be parsed. */
  readonly parsed: ReadonlyMap<string, readonly ParsedImport[] | null>;
  /** Paths that changed but no longer exist at HEAD. */
  readonly removed: readonly string[];
  readonly manifests: readonly Manifest[];
  readonly manifestErrors: readonly string[];
  readonly parseFailures: readonly string[];
}

/**
 * Build the dependency graph as it stands at HEAD:
 * - imports of every source file (re-parsed only when the file changed since
 *   the last snapshot),
 * - dependencies declared in manifests (`repository DEPENDS_ON dependency`, FACT),
 * - resolved imports (`file IMPORTS file` and `file DEPENDS_ON dependency`,
 *   DERIVED, each citing the import statement's evidence).
 *
 * The graph is a snapshot: edges that no longer hold at HEAD are removed.
 * All writes happen in one transaction, so a failure never leaves half a graph.
 */
export async function indexDependencies(
  db: FossilDb,
  repositoryId: number,
  root: string,
  headSha: string | null,
  options: { readonly now?: () => Date } = {},
): Promise<DependencyIndexResult> {
  const previous = getGraphIndexedSha(db, repositoryId);
  if (!headSha || previous === headSha) return UNCHANGED;
  const observedAt = (options.now ?? (() => new Date()))().toISOString();

  const changed = previous ? await changedPaths(root, previous, headSha) : null;
  const snapshot = await readSnapshot(root, headSha, changed);

  return db.transaction((tx) => {
    for (const path of snapshot.removed) {
      const file = findFileByPath(tx, repositoryId, path);
      if (file) deleteFileImports(tx, file.id);
    }
    for (const [path, found] of snapshot.parsed) {
      const file = ensureFile(tx, repositoryId, path, detectLanguage(path));
      replaceFileImports(tx, repositoryId, file, headSha, found ?? []);
    }
    const dependencies = writeManifests(tx, repositoryId, headSha, snapshot.manifests, observedAt);
    const edges = rebuildImportEdges(tx, repositoryId, snapshot, observedAt);
    setGraphIndexedSha(tx, repositoryId, headSha);
    return {
      mode: changed ? 'incremental' : 'full',
      filesParsed: snapshot.parsed.size,
      manifests: snapshot.manifests.length,
      manifestErrors: snapshot.manifestErrors,
      parseFailures: snapshot.parseFailures,
      dependencies,
      ...edges,
    };
  });
}

/** Read and parse everything the snapshot needs before any database write. */
async function readSnapshot(
  root: string,
  headSha: string,
  changed: ReadonlySet<string> | null,
): Promise<Snapshot> {
  const headFiles = await listHeadFiles(root);
  const toParse = [...headFiles].filter(
    (path) => grammarForPath(path) !== null && (changed === null || changed.has(path)),
  );
  const manifestPaths = [...headFiles].filter(isManifestPath);
  const requests = [...toParse, ...manifestPaths].map((path) => ({ path, revision: headSha }));

  const parsed = new Map<string, readonly ParsedImport[] | null>();
  const manifests: Manifest[] = [];
  const manifestErrors: string[] = [];
  const parseFailures: string[] = [];
  const extractor = new SymbolExtractor();
  try {
    for await (const { request, content } of readBlobs(root, requests)) {
      const grammar = grammarForPath(request.path);
      if (isManifestPath(request.path) && !grammar) {
        if (!content) continue;
        try {
          manifests.push(parseManifest(request.path, content.toString('utf8')));
        } catch (error) {
          if (!(error instanceof ManifestParseError)) throw error;
          manifestErrors.push(error.message);
        }
      } else if (grammar) {
        parsed.set(
          request.path,
          await parseImports(extractor, grammar, content, () => parseFailures.push(request.path)),
        );
      }
    }
  } finally {
    await extractor.dispose();
  }
  const removed = changed ? [...changed].filter((path) => !headFiles.has(path)) : [];
  return { headFiles, parsed, removed, manifests, manifestErrors, parseFailures };
}

async function parseImports(
  extractor: SymbolExtractor,
  grammar: NonNullable<ReturnType<typeof grammarForPath>>,
  content: Buffer | null,
  onFailure: () => void,
): Promise<readonly ParsedImport[] | null> {
  // Binary, oversized or unreadable content has no imports to report.
  if (!content || content.includes(0)) return null;
  try {
    return (await extractor.extract(content.toString('utf8'), grammar))?.imports ?? null;
  } catch {
    // One unparseable file must not stop the graph; it is reported and contributes no edges.
    onFailure();
    return null;
  }
}

function writeManifests(
  db: FossilDb,
  repositoryId: number,
  headSha: string,
  manifests: readonly Manifest[],
  observedAt: string,
): number {
  deleteRelationsByProducer(db, repositoryId, MANIFEST_READER_PRODUCER);
  deleteEvidenceOfType(db, repositoryId, 'manifest');
  markDependenciesStale(db, repositoryId);
  // Packages defined by a manifest in this repository are workspaces, not external code.
  const localPackages = new Set(
    manifests.flatMap((m) => (m.packageName ? [`${m.ecosystem}:${m.packageName}`] : [])),
  );
  let count = 0;
  for (const manifest of manifests) {
    for (const dep of manifest.dependencies) {
      const row = upsertDependency(db, {
        repositoryId,
        manifestFile: manifest.path,
        ecosystem: dep.ecosystem,
        name: dep.name,
        version: dep.version,
        scope: dep.scope,
        internal: localPackages.has(`${dep.ecosystem}:${dep.name}`),
      });
      const evidence = recordEvidence(db, {
        repositoryId,
        type: 'manifest',
        locator: `${manifest.path}@${headSha}#${dep.scope}:${dep.name}`,
        excerpt: dep.version ? `${dep.name} ${dep.version}` : dep.name,
      });
      recordRelation(db, {
        repositoryId,
        source: { type: 'repository', id: repositoryId },
        relation: 'DEPENDS_ON',
        target: { type: 'dependency', id: row.id },
        evidenceType: 'FACT',
        confidence: 1,
        provenance: {
          producer: MANIFEST_READER_PRODUCER,
          method: `${manifest.ecosystem}-manifest`,
          evidenceIds: [evidence.id],
          observedAt,
        },
      });
      count++;
    }
    // Declared runtime support; dead-intent analysis compares version references against it.
    for (const runtime of manifest.runtimes) {
      recordEvidence(db, {
        repositoryId,
        type: 'manifest',
        locator: `${manifest.path}@${headSha}#runtime:${runtime.runtime}`,
        excerpt: `${runtime.runtime} ${runtime.constraint}`,
        metadata: { ...runtime, minimum: minimumVersion(runtime.constraint) },
      });
    }
  }
  return count;
}

interface Edge {
  readonly sourceFileId: number;
  readonly target: { readonly type: 'file' | 'dependency'; readonly id: number };
  confidence: number;
  readonly evidenceIds: Set<number>;
  readonly methods: Set<string>;
}

function describe(resolution: Resolution): string | null {
  switch (resolution.kind) {
    case 'files':
      return resolution.paths.join(', ');
    case 'dependency':
      return `${resolution.ecosystem}:${resolution.name}`;
    case 'builtin':
      return null;
    case 'unresolved':
      return resolution.reason;
  }
}

/**
 * Resolve every import at HEAD and rewrite the derived edges. Several imports
 * of the same target collapse into one edge citing all of their evidence.
 */
function rebuildImportEdges(
  db: FossilDb,
  repositoryId: number,
  snapshot: Snapshot,
  observedAt: string,
): Pick<
  DependencyIndexResult,
  'importEdges' | 'dependencyEdges' | 'builtinImports' | 'unresolvedImports'
> {
  deleteRelationsByProducer(db, repositoryId, IMPORT_RESOLVER_PRODUCER);
  const resolve = createResolver({ files: snapshot.headFiles, manifests: snapshot.manifests });
  const edges = new Map<string, Edge>();
  let builtinImports = 0;
  let unresolvedImports = 0;

  const addEdge = (
    item: RepositoryImport,
    target: Edge['target'],
    confidence: number,
    method: string,
  ) => {
    const key = `${item.fileId}>${target.type}:${target.id}`;
    const edge = edges.get(key) ?? {
      sourceFileId: item.fileId,
      target,
      confidence: 0,
      evidenceIds: new Set<number>(),
      methods: new Set<string>(),
    };
    edge.confidence = Math.max(edge.confidence, confidence);
    if (item.evidenceId !== null) edge.evidenceIds.add(item.evidenceId);
    edge.methods.add(method);
    edges.set(key, edge);
  };

  for (const item of listRepositoryImports(db, repositoryId)) {
    const grammar = grammarForPath(item.path);
    if (!grammar || !snapshot.headFiles.has(item.path)) continue;
    const resolution = resolve(item.path, grammar, {
      specifier: item.specifier,
      kind: item.kind,
      ...(item.names ? { names: item.names } : {}),
    });
    setImportResolution(db, item.id, resolution.kind, describe(resolution));

    if (resolution.kind === 'files') {
      for (const path of resolution.paths) {
        if (path === item.path) continue;
        const target = ensureFile(db, repositoryId, path, detectLanguage(path));
        addEdge(item, { type: 'file', id: target.id }, resolution.confidence, resolution.method);
      }
    } else if (resolution.kind === 'dependency') {
      const dependency = findDependency(
        db,
        repositoryId,
        resolution.manifestPath,
        resolution.ecosystem,
        resolution.name,
      );
      if (dependency)
        addEdge(item, { type: 'dependency', id: dependency.id }, 1, resolution.method);
    } else if (resolution.kind === 'builtin') {
      builtinImports++;
    } else {
      unresolvedImports++;
    }
  }

  let importEdges = 0;
  let dependencyEdges = 0;
  for (const edge of edges.values()) {
    recordRelation(db, {
      repositoryId,
      source: { type: 'file', id: edge.sourceFileId },
      relation: edge.target.type === 'file' ? 'IMPORTS' : 'DEPENDS_ON',
      target: edge.target,
      evidenceType: 'DERIVED',
      confidence: edge.confidence,
      provenance: {
        producer: IMPORT_RESOLVER_PRODUCER,
        method: [...edge.methods].sort().join('+'),
        evidenceIds: [...edge.evidenceIds],
        observedAt,
      },
    });
    if (edge.target.type === 'file') importEdges++;
    else dependencyEdges++;
  }
  return { importEdges, dependencyEdges, builtinImports, unresolvedImports };
}
