import * as vscode from 'vscode';
import {
  hoverMarkdown,
  lensTitle,
  parseLens,
  symbolAt,
  type FileLens,
  type LensEntry,
} from './lens.js';
import { McpClient } from './mcp-client.js';

/** `npx --yes codefossil mcp`; on Windows npx is a batch file, so it runs through cmd.exe. */
function defaultCommand(): string[] {
  return process.platform === 'win32'
    ? ['cmd.exe', '/d', '/s', '/c', '"npx --yes codefossil mcp"']
    : ['npx', '--yes', 'codefossil', 'mcp'];
}

/** How far a definition may have drifted from its line at HEAD in the open document. */
const DRIFT = 5;

class Codefossil implements vscode.Disposable {
  private readonly clients = new Map<string, McpClient>();
  private readonly lenses = new Map<string, Promise<FileLens | null>>();
  private readonly output = vscode.window.createOutputChannel('CODEFOSSIL');
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changed.event;

  dispose(): void {
    for (const client of this.clients.values()) client.dispose();
    this.clients.clear();
    this.output.dispose();
    this.status.dispose();
    this.changed.dispose();
  }

  restart(): void {
    for (const client of this.clients.values()) client.dispose();
    this.clients.clear();
    this.refresh();
  }

  /** History only changes with commits; saving is a cheap moment to look again. */
  refresh(): void {
    this.lenses.clear();
    this.changed.fire();
  }

  private client(folder: vscode.WorkspaceFolder): McpClient {
    const key = folder.uri.toString();
    let client = this.clients.get(key);
    if (!client) {
      const configured = vscode.workspace
        .getConfiguration('codefossil')
        .get<string[]>('command', []);
      const [command = '', ...args] = configured.length > 0 ? configured : defaultCommand();
      client = new McpClient(command, args, folder.uri.fsPath, (text) => {
        this.output.append(text);
      });
      this.clients.set(key, client);
    }
    return client;
  }

  /** The lens of a file: one `lens` call per file, cached until the next save. */
  lens(document: vscode.TextDocument): Promise<FileLens | null> {
    const key = document.uri.toString();
    const cached = this.lenses.get(key);
    if (cached) return cached;
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!folder || document.uri.scheme !== 'file') return Promise.resolve(null);
    const path = vscode.workspace.asRelativePath(document.uri, false);
    this.status.text = '$(sync~spin) CODEFOSSIL reading history…';
    this.status.show();
    const pending = this.client(folder)
      .callTool('lens', { path })
      .then((result) => (result.isError ? null : parseLens(result.text)))
      .catch((error: unknown) => {
        this.output.appendLine(
          `lens ${path}: ${error instanceof Error ? error.message : String(error)}`,
        );
        return null;
      })
      .finally(() => {
        this.status.hide();
      });
    this.lenses.set(key, pending);
    return pending;
  }

  /** The line where an entry's definition is in the open document, or null when it moved away. */
  static lineOf(document: vscode.TextDocument, entry: LensEntry): number | null {
    const name = entry.qualifiedName.split('.').at(-1) ?? entry.qualifiedName;
    const at = entry.startLine - 1;
    for (let offset = 0; offset <= DRIFT; offset++) {
      for (const line of offset === 0 ? [at] : [at - offset, at + offset]) {
        if (line >= 0 && line < document.lineCount && document.lineAt(line).text.includes(name)) {
          return line;
        }
      }
    }
    return null;
  }

  async showHistory(document: vscode.TextDocument, entry: LensEntry): Promise<void> {
    const folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!folder) return;
    const path = vscode.workspace.asRelativePath(document.uri, false);
    const result = await this.client(folder).callTool('why', {
      target: `${path}:${entry.qualifiedName}`,
    });
    this.output.clear();
    this.output.appendLine(result.text);
    this.output.show(true);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const fossil = new Codefossil();
  const selector: vscode.DocumentSelector = [
    'javascript',
    'javascriptreact',
    'typescript',
    'typescriptreact',
    'python',
    'go',
    'rust',
  ].map((language) => ({ language, scheme: 'file' }));

  context.subscriptions.push(
    fossil,
    vscode.languages.registerCodeLensProvider(selector, {
      onDidChangeCodeLenses: fossil.onDidChangeCodeLenses,
      async provideCodeLenses(document) {
        if (!vscode.workspace.getConfiguration('codefossil').get<boolean>('codeLens', true))
          return [];
        const lens = await fossil.lens(document);
        return (lens?.symbols ?? []).flatMap((entry) => {
          const line = Codefossil.lineOf(document, entry);
          if (line === null) return [];
          return [
            new vscode.CodeLens(new vscode.Range(line, 0, line, 0), {
              title: lensTitle(entry),
              tooltip: 'Show the history of this function',
              command: 'codefossil.showHistory',
              arguments: [document.uri, entry],
            }),
          ];
        });
      },
    }),
    vscode.languages.registerHoverProvider(selector, {
      async provideHover(document, position) {
        const lens = await fossil.lens(document);
        const entry = lens ? symbolAt(lens, position.line + 1) : null;
        if (!entry || Codefossil.lineOf(document, entry) !== position.line) return null;
        const markdown = new vscode.MarkdownString(hoverMarkdown(entry));
        markdown.isTrusted = false;
        markdown.supportHtml = false;
        return new vscode.Hover(markdown);
      },
    }),
    vscode.commands.registerCommand(
      'codefossil.showHistory',
      async (uri?: vscode.Uri, entry?: LensEntry) => {
        const editor = vscode.window.activeTextEditor;
        const document = uri ? await vscode.workspace.openTextDocument(uri) : editor?.document;
        if (!document) return;
        let target = entry;
        if (!target && editor) {
          const lens = await fossil.lens(document);
          target = (lens && symbolAt(lens, editor.selection.active.line + 1)) ?? undefined;
        }
        if (!target) {
          void vscode.window.showInformationMessage(
            'CODEFOSSIL: put the cursor inside a function.',
          );
          return;
        }
        await fossil.showHistory(document, target);
      },
    ),
    vscode.commands.registerCommand('codefossil.restart', () => {
      fossil.restart();
    }),
    vscode.workspace.onDidSaveTextDocument(() => {
      fossil.refresh();
    }),
  );
}

export function deactivate(): void {
  // Disposables registered on the context are released by VS Code.
}
