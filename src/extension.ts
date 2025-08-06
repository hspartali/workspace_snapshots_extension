import * as vscode from 'vscode';
import { SnapshotProvider } from './SnapshotProvider';
import { Snapshot, SnapshotFile } from './Snapshot';
import { Git } from './Git';
import * as path from 'path';
import { ReadonlyContentProvider } from './ReadonlyContentProvider';
import { SnapshotFileDecorationProvider } from './SnapshotFileDecorationProvider';

export function activate(context: vscode.ExtensionContext) {

    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
        // Can't function without a workspace folder.
        return;
    }

    console.log('Congratulations, your extension "workspace-snapshots" is now active!');

    const git = new Git();
    const snapshotProvider = new SnapshotProvider(context, git);
    const readonlyProvider = new ReadonlyContentProvider(git);
    const decorationProvider = new SnapshotFileDecorationProvider(snapshotProvider);

    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('workspace_snapshot-readonly', readonlyProvider));
    vscode.window.registerTreeDataProvider('workspaceSnapshotsView', snapshotProvider);
    context.subscriptions.push(vscode.window.registerFileDecorationProvider(decorationProvider));

    // Set up a file watcher to refresh readonly content when snapshot files are changed.
    const workspaceRoot = vscode.workspace.workspaceFolders[0].uri.fsPath;
    const snapshotStoragePath = path.join(workspaceRoot, '.vscode', 'workspace_snapshots');

    const fileWatcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(snapshotStoragePath, '**/*')
    );

    const onFileChange = (diskUri: vscode.Uri) => {
        // Exclude metadata file from triggering updates as it has no corresponding content URI.
        if (path.basename(diskUri.fsPath) === 'metadata.json') {
            return;
        }

        // The path on disk is .../.vscode/workspace_snapshots/[snapshotId]/[file_path]
        // We need to build the content provider URI: workspace_snapshot-readonly:[file_path]?snapshotId=[snapshotId]
        const relativePath = path.relative(snapshotStoragePath, diskUri.fsPath);
        const standardPath = relativePath.replace(/\\/g, '/'); // Standardize to forward slashes
        const parts = standardPath.split('/');

        if (parts.length > 1) {
            const snapshotId = parts[0];
            const filePath = parts.slice(1).join('/');

            const providerUri = vscode.Uri.parse(`workspace_snapshot-readonly:${filePath}?snapshotId=${snapshotId}`);
            readonlyProvider.fireOnDidChange(providerUri);
        }
    };

    fileWatcher.onDidChange(onFileChange);
    fileWatcher.onDidCreate(onFileChange);
    fileWatcher.onDidDelete(onFileChange);
    context.subscriptions.push(fileWatcher);

    // When the tree data changes, we trigger a decoration refresh.
    snapshotProvider.onDidChangeTreeData(() => {
        decorationProvider.refresh();
    });

    context.subscriptions.push(vscode.commands.registerCommand('workspace_snapshots.refresh', () => {
        snapshotProvider.refresh();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('workspace_snapshots.snapshot', async () => {
        // Generate a snapshot name from the current date and time.
        const snapshotName = new Date().toLocaleString();
        try {
            await snapshotProvider.createSnapshot(snapshotName);
            vscode.window.showInformationMessage(`Snapshot "${snapshotName}" created.`);
            snapshotProvider.refresh();
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to create snapshot: ${error.message}`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('workspace_snapshots.showDiff', async (snapshot: Snapshot, filePath: string) => {
        try {
            const uris = await snapshotProvider.getDiffUris(snapshot, filePath);
            if (uris) {
                const { left, right } = uris;
                const title = `${path.basename(filePath)} (${snapshot.getPreviousSnapshotName()} vs ${snapshot.label})`;
                // The preserveFocus option keeps the focus on the tree view, making the selection highlight stay prominent.
                await vscode.commands.executeCommand('vscode.diff', left, right, title, { preserveFocus: true });
            }
        } catch (error: any) {
            vscode.window.showErrorMessage(`Could not show diff: ${error.message}`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('workspace_snapshots.restore', async (snapshot: Snapshot) => {
        const confirm = await vscode.window.showWarningMessage(
            `This will discard all uncommitted changes in your workspace and revert all files to the state of snapshot '${snapshot.label}'. This cannot be undone.`,
            { modal: true },
            'Restore Snapshot'
        );

        if (confirm === 'Restore Snapshot') {
            await snapshotProvider.restoreSnapshot(snapshot.id);
            vscode.window.showInformationMessage(`Workspace restored to snapshot "${snapshot.label}".`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('workspace_snapshots.rename', async (snapshot: Snapshot) => {
        const newName = await vscode.window.showInputBox({
            prompt: 'Enter the new name for the snapshot',
            value: snapshot.originalLabel
        });

        if (newName && newName !== snapshot.originalLabel) {
            snapshotProvider.renameSnapshot(snapshot.id, newName);
            snapshotProvider.refresh();
            vscode.window.showInformationMessage(`Snapshot renamed to "${newName}".`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('workspace_snapshots.clearAllSnapshots', async () => {
        const confirm = await vscode.window.showWarningMessage(
            `Are you sure you want to clear ALL snapshots history? This will NOT revert your files, only remove the snapshot metadata and file copies. This is not reversible.`,
            { modal: true },
            'Clear All'
        );
        if (confirm === 'Clear All') {
            await snapshotProvider.clearAllSnapshots();
            snapshotProvider.refresh();
            vscode.window.showInformationMessage('All snapshots history has been cleared.');
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('workspace_snapshots.openFile', async (file: SnapshotFile) => {
        const workspaceRoot = git.getRepoRoot();
        if (!workspaceRoot) {
            vscode.window.showErrorMessage("Could not find repository root.");
            return;
        }

        try {
            const fileUri = vscode.Uri.file(path.join(workspaceRoot, file.label));
            const doc = await vscode.workspace.openTextDocument(fileUri);
            await vscode.window.showTextDocument(doc, { preview: false });
        } catch (error: any) {
            vscode.window.showErrorMessage(`Could not open file '${file.label}': ${error.message}`);
        }
    }));
}

export function deactivate() {}
