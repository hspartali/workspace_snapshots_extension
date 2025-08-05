import * as vscode from 'vscode';
import { SnapshotProvider } from './SnapshotProvider';
import { Snapshot, SnapshotFile } from './Snapshot';
import { Git } from './Git';
import * as path from 'path';
import { ReadonlyContentProvider } from './ReadonlyContentProvider';
import { SnapshotFileDecorationProvider } from './SnapshotFileDecorationProvider';

export function activate(context: vscode.ExtensionContext) {

    console.log('Congratulations, your extension "changelayers" is now active!');

    const git = new Git();
    const snapshotProvider = new SnapshotProvider(context, git);
    const readonlyProvider = new ReadonlyContentProvider(git);
    const decorationProvider = new SnapshotFileDecorationProvider(snapshotProvider);

    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('workspace_snapshot-readonly', readonlyProvider));
    vscode.window.registerTreeDataProvider('workspaceSnapshotsView', snapshotProvider);
    context.subscriptions.push(vscode.window.registerFileDecorationProvider(decorationProvider));

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

    context.subscriptions.push(vscode.commands.registerCommand('workspace_snapshots.discardFile', async (file: SnapshotFile) => {
        const isLastChange = snapshotProvider.isLastChangeForFile(file);

        let confirm: string | undefined;
        if (isLastChange) {
            confirm = await vscode.window.showWarningMessage(
                `This is the last change to "${file.label}". This action will revert your working file to its previous state and remove the change from this snapshot's history. This cannot be undone.`,
                { modal: true },
                'Discard and Revert File'
            );
        } else {
            confirm = await vscode.window.showWarningMessage(
                `This change to "${file.label}" is superseded by a later snapshot. This action will only remove the change from this snapshot's history and will NOT revert your working file.`,
                { modal: true },
                'Remove from History'
            );
        }

        if (confirm) { // User confirmed one of the actions
            await snapshotProvider.discardOrRemoveFileFromSnapshot(file);
            snapshotProvider.refresh();
            const message = isLastChange
                ? `Reverted "${file.label}" and removed it from the snapshot.`
                : `Removed change to "${file.label}" from snapshot history.`;
            vscode.window.showInformationMessage(message);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('workspace_snapshots.discard', async (snapshot: Snapshot) => {
        const confirm = await vscode.window.showWarningMessage(
            `Are you sure you want to remove all changes from snapshot "${snapshot.label}"? This will not revert your working files, but will rewrite this snapshot's history. This is not reversible.`,
            { modal: true },
            'Remove All Changes'
        );
        if (confirm === 'Remove All Changes') {
            await snapshotProvider.discardSnapshot(snapshot.id);
            vscode.window.showInformationMessage(`Removed all changes from snapshot "${snapshot.label}".`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('workspace_snapshots.discardAll', async () => {
        const confirm = await vscode.window.showWarningMessage(
            `Are you sure you want to discard ALL snapshots? This is not reversible and will revert your files.`,
            { modal: true },
            'Discard All'
        );
        if (confirm === 'Discard All') {
            await snapshotProvider.discardAllSnapshots();
            snapshotProvider.refresh();
            vscode.window.showInformationMessage('All snapshots have been discarded and files reverted.');
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
