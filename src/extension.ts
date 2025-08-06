import * as vscode from 'vscode';
import * as path from 'path';
import { SnapshotProvider } from './SnapshotProvider';
import { Snapshot, SnapshotFile } from './Snapshot';
import { ReadonlyContentProvider } from './ReadonlyContentProvider';
import { SnapshotFileDecorationProvider } from './SnapshotFileDecorationProvider';

export async function activate(context: vscode.ExtensionContext) {
    if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
        vscode.window.showWarningMessage("Workspace Snapshots requires an open folder to function.");
        return;
    }

    console.log('Congratulations, your extension "workspace-snapshots" is now active!');

    const snapshotProvider = new SnapshotProvider(context);
    try {
        await snapshotProvider.initialize();
    } catch (error: any) {
        vscode.window.showErrorMessage(`Failed to initialize Workspace Snapshots: ${error.message}`);
        return; // Block activation if initialization fails
    }

    const readonlyProvider = new ReadonlyContentProvider(snapshotProvider.git);
    const decorationProvider = new SnapshotFileDecorationProvider(snapshotProvider);

    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('workspace-snapshot', readonlyProvider));
    vscode.window.registerTreeDataProvider('workspaceSnapshotsView', snapshotProvider);
    context.subscriptions.push(vscode.window.registerFileDecorationProvider(decorationProvider));

    snapshotProvider.onDidChangeTreeData(() => {
        decorationProvider.refresh();
    });

    context.subscriptions.push(vscode.commands.registerCommand('workspace_snapshots.snapshot', async () => {
        // Generate a snapshot name from the current date and time.
        const snapshotName = new Date().toLocaleString();
        try {
            await snapshotProvider.createSnapshot(snapshotName);
            vscode.window.showInformationMessage(`Snapshot "${snapshotName}" created.`);
            snapshotProvider.refresh();
        } catch (error: any) {
            if (error.message === "No changes detected since the last snapshot.") {
                vscode.window.showWarningMessage("No changes detected since the last snapshot.");
            } else {
                vscode.window.showErrorMessage(`Failed to create snapshot: ${error.message}`);
            }
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('workspace_snapshots.rename', async (snapshot: Snapshot) => {
        const currentName = snapshot.customName || snapshot.commit.message;
        const newName = await vscode.window.showInputBox({
            prompt: 'Enter the new name for the snapshot',
            value: currentName
        });

        if (newName && newName !== currentName) {
            snapshotProvider.renameSnapshot(snapshot.id!, newName);
            snapshotProvider.refresh();
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('workspace_snapshots.deleteSnapshot', async (snapshot: Snapshot) => {
        const snapshotLabel = snapshot.customName || snapshot.commit.message;
        const confirm = await vscode.window.showWarningMessage(
            `Are you sure you want to delete the snapshot '${snapshotLabel}'? This cannot be undone.`,
            { modal: true },
            'Delete'
        );

        if (confirm === 'Delete') {
            snapshotProvider.deleteSnapshot(snapshot.id!);
            snapshotProvider.refresh();
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('workspace_snapshots.showDiff', async (item: Snapshot | SnapshotFile) => {
        try {
            const uris = await snapshotProvider.getDiffUris(item);
            if (uris) {
                const { left, right, title } = uris;
                await vscode.commands.executeCommand('vscode.diff', left, right, title, { preserveFocus: true });
            } else if (item instanceof SnapshotFile && item.status === 'A') {
                // For added files, just show the file from the snapshot
                const right = await snapshotProvider.getDiffUris(item);
                if (right) {
                    vscode.window.showTextDocument(right.right);
                }
            }
        } catch (error: any) {
            vscode.window.showErrorMessage(`Could not show diff: ${error.message}`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('workspace_snapshots.restore', async (snapshot: Snapshot) => {
        const snapshotLabel = typeof snapshot.label === 'string' ? snapshot.label : snapshot.label?.label;

        if (!snapshot.id || !snapshotLabel) {
            vscode.window.showErrorMessage("Cannot restore: invalid snapshot data.");
            return;
        }

        const confirm = await vscode.window.showWarningMessage(
            `This will revert all files in your workspace to the state of snapshot '${snapshotLabel}'. This cannot be undone.`,
            { modal: true },
            'Restore Snapshot'
        );

        if (confirm === 'Restore Snapshot') {
            try {
                await snapshotProvider.restoreSnapshot(snapshot.id);
                snapshotProvider.refresh();
                vscode.window.showInformationMessage(`Workspace restored to snapshot "${snapshotLabel}".`);
            } catch (error: any) {
                vscode.window.showErrorMessage(`Failed to restore snapshot: ${error.message}`);
            }
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('workspace_snapshots.clearAllSnapshots', async () => {
        const confirm = await vscode.window.showWarningMessage(
            `Are you sure you want to clear ALL snapshots? This will permanently delete the shadow Git repository for this workspace. This action is not reversible.`,
            { modal: true },
            'Clear All'
        );
        if (confirm === 'Clear All') {
            try {
                await snapshotProvider.clearAllSnapshots();
                snapshotProvider.refresh();
                vscode.window.showInformationMessage('All snapshots have been cleared.');
            } catch (error: any) {
                vscode.window.showErrorMessage(`Failed to clear snapshots: ${error.message}`);
            }
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('workspace_snapshots.openFile', async (file: SnapshotFile) => {
        if (!snapshotProvider.workspaceRoot) {
            vscode.window.showErrorMessage("Could not determine workspace root.");
            return;
        }

        try {
            const fileUri = vscode.Uri.file(path.join(snapshotProvider.workspaceRoot, file.filePath));
            await vscode.window.showTextDocument(fileUri, { preview: true });
        } catch (error: any) {
            // File might not exist in the workspace (e.g., deleted), which is fine.
            // A more specific error for other cases could be useful.
            console.warn(`Could not open file '${file.label}': ${error.message}`);
        }
    }));
}

export function deactivate() {}
