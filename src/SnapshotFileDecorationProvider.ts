import * as vscode from 'vscode';
import { SnapshotProvider } from './SnapshotProvider';

export class SnapshotFileDecorationProvider implements vscode.FileDecorationProvider {
    private _onDidChangeFileDecorations: vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined> = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
    readonly onDidChangeFileDecorations: vscode.Event<vscode.Uri | vscode.Uri[] | undefined> = this._onDidChangeFileDecorations.event;

    constructor(private snapshotProvider: SnapshotProvider) { }

    public refresh(): void {
        // Fire with no argument to signal a global refresh for all file decorations.
        this._onDidChangeFileDecorations.fire(undefined);
    }

    async provideFileDecoration(uri: vscode.Uri, token: vscode.CancellationToken): Promise<vscode.FileDecoration | undefined> {
        // We only decorate URIs that are part of our tree view.
        // We encoded the snapshotId and path in the query string of the resourceUri.
        const query = new URLSearchParams(uri.query);
        const snapshotId = query.get('snapshotId');
        const filePath = query.get('path');

        if (!snapshotId || !filePath) {
            // This URI is not from our tree, so we don't decorate it.
            return undefined;
        }

        const snapshot = this.snapshotProvider.getSnapshotById(snapshotId);
        if (!snapshot) {
            return undefined;
        }

        const fileInfo = snapshot.changedFiles.find(f => f.path === filePath);
        if (!fileInfo) {
            return undefined;
        }

        switch (fileInfo.status) {
            case 'A':
                // The screenshot uses 'U' for new/untracked files.
                return new vscode.FileDecoration('U', 'Added', new vscode.ThemeColor('gitDecoration.untrackedResourceForeground'));
            case 'M':
                return new vscode.FileDecoration('M', 'Modified', new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'));
            case 'D':
                return new vscode.FileDecoration('D', 'Deleted', new vscode.ThemeColor('gitDecoration.deletedResourceForeground'));
            default:
                return undefined;
        }
    }
}
