import * as vscode from 'vscode';
import { SnapshotProvider } from './SnapshotProvider';

export class SnapshotFileDecorationProvider implements vscode.FileDecorationProvider {
    private _onDidChangeFileDecorations = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
    readonly onDidChangeFileDecorations = this._onDidChangeFileDecorations.event;

    constructor(private snapshotProvider: SnapshotProvider) {}

    public refresh(): void {
        this._onDidChangeFileDecorations.fire(undefined);
    }

    async provideFileDecoration(uri: vscode.Uri, token: vscode.CancellationToken): Promise<vscode.FileDecoration | undefined> {
        // We only decorate URIs from our tree view, identified by the query string.
        const query = new URLSearchParams(uri.query);
        const status = query.get('status');

        if (!status) {
            return undefined;
        }

        switch (status) {
            case 'A':
                return new vscode.FileDecoration('A', 'Added', new vscode.ThemeColor('gitDecoration.untrackedResourceForeground'));
            case 'M':
                return new vscode.FileDecoration('M', 'Modified', new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'));
            case 'D':
                return new vscode.FileDecoration('D', 'Deleted', new vscode.ThemeColor('gitDecoration.deletedResourceForeground'));
            default:
                return undefined;
        }
    }
}
