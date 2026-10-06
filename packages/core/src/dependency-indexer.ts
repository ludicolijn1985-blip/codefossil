import {
  deleteEvidenceOfType,
  deleteFileCalls,
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
  replaceFileCalls,
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
  extendedConfigPaths,
  isManifestPath,
  isTsConfigPath,
  ManifestParseError,
  parseManifest,
  parseTsConfig,
  TsConfigParseError,
  type Manifest,
  type Resolution,
  minimumVersion,
  type TsConfig,
} from '@codefossil/graph';
import {
  grammarForPath,
  SymbolExtractor,
  type ParsedCall,
  type ParsedImport,
} from '@codefossil/parser';
import { rebuildCallEdges } from './call-graph.js';
import { detectLanguage } from '@codefossil/shared';

export const IMPORT_RESOLVER_PRODUCER = 'import-resolver@0.1.0';
export const MANIFEST_READER_PRODUCER = 'manifest-reader@0.1.0';

export interface DependencyIndexResult {
  /** `unchanged` when HEAD is the snapshot already indexed. */
  readonly mode: 'full' | 'incremental' | 'unchanged';
  readonly filesParsed: number;
  readonly manifests: number;
  /** Manifests and TypeScript configs that could not be parsed, with the reason. */
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
  /** Distinct call sites at HEAD, and the `CALLS` edges resolved from them. */
  readonly calls: number;
  readonly callEdges: number;
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
  calls: 0,
  callEdges: 0,
};

interface ParsedFile {
  readonly imports: readonly ParsedImport[];
  readonly calls: readonly ParsedCall[];
}

interface Snapshot {
  readonly headFiles: ReadonlySet<string>;
  /** Freshly parsed imports and calls per path; null when the file could not be parsed. */
  readonly parsed: ReadonlyMap<string, ParsedFile | null>;
  /** Paths that changed but no longer exist at HEAD. */
  readonly removed: readonly string[];
  readonly manifests: readonly Manifest[];
  /** `tsconfig.json` files and the repository configs they extend. */
  readonly tsconfigs: readonly TsConfig[];
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
      if (file) {
        deleteFileImports(tx, file.id);
        deleteFileCalls(tx, file.id);
      }
    }
    for (const [path, found] of snapshot.parsed) {
      const file = ensureFile(tx, repositoryId, path, detectLanguage(path));
      replaceFileImports(tx, repositoryId, file, headSha, found?.imports ?? []);
      replaceFileCalls(tx, file.id, headSha, found?.calls ?? []);
    }
    const dependencies = writeManifests(tx, repositoryId, headSha, snapshot.manifests, observedAt);
    const edges = rebuildImportEdges(tx, repositoryId, snapshot, observedAt);
    const callGraph = rebuildCallEdges(tx, repositoryId, observedAt);
    setGraphIndexedSha(tx, repositoryId, headSha);
    return {
      mode: changed ? 'incremental' : 'full',
      filesParsed: snapshot.parsed.size,
      manifests: snapshot.manifests.length,
      manifestErrors: snapshot.manifestErrors,
      parseFailures: snapshot.parseFailures,
      dependencies,
      ...edges,
      ...callGraph,
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

  const parsed = new Map<string, ParsedFile | null>();
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
          await parseFile(extractor, grammar, content, () => parseFailures.push(request.path)),
        );
      }
    }
  } finally {
    await extractor.dispose();
  }
  const tsconfigs = await readTsConfigs(root, headSha, headFiles, (message) =>
    manifestErrors.push(message),
  );
  const removed = changed ? [...changed].filter((path) => !headFiles.has(path)) : [];
  return { headFiles, parsed, removed, manifests, tsconfigs, manifestErrors, parseFailures };
}

/**
 * Read every `tsconfig*.json`/`jsconfig*.json` at HEAD, then whatever other
 * repository files their `extends` chains name. Configs outside the
 * repository (packages in `node_modules`) are never read.
 */
async function readTsConfigs(
  root: string,
  headSha: string,
  headFiles: ReadonlySet<string>,
  onError: (message: string) => void,
): Promise<TsConfig[]> {
  const configs: TsConfig[] = [];
  const requested = new Set<string>();
  let pending = [...headFiles].filter(isTsConfigPath);
  while (pending.length > 0) {
    for (const path of pending) requested.add(path);
    const requests = pending.map((path) => ({ path, revision: headSha }));
    const read: TsConfig[] = [];
    for await (const { request, content } of readBlobs(root, requests)) {
      if (!content) continue;
      try {
        read.push(parseTsConfig(request.path, content.toString('utf8')));
      } catch (error) {
        if (!(error instanceof TsConfigParseError)) throw error;
        onError(error.message);
      }
    }
    configs.push(...read);
    pending = [...new Set(read.flatMap((config) => extendedConfigPaths(config, headFiles)))].filter(
      (path) => !requested.has(path),
    );
  }
  return configs;
}

async function parseFile(
  extractor: SymbolExtractor,
  grammar: NonNullable<ReturnType<typeof grammarForPath>>,
  content: Buffer | null,
  onFailure: () => void,
): Promise<ParsedFile | null> {
  // Binary, oversized or unreadable content has no imports or calls to report.
  if (!content || content.includes(0)) return null;
  try {
    const result = await extractor.extract(content.toString('utf8'), grammar);
    return result ? { imports: result.imports, calls: result.calls } : null;
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
  const resolve = createResolver({
    files: snapshot.headFiles,
    manifests: snapshot.manifests,
    tsconfigs: snapshot.tsconfigs,
  });
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
