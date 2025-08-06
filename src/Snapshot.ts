import * as vscode from 'vscode';
import * as path from 'path';
import { Commit, FileChange } from './Git';

export class Snapshot extends vscode.TreeItem {
    constructor(
        public readonly commit: Commit,
    ) {
        super(commit.message, vscode.TreeItemCollapsibleState.Collapsed);
        this.id = commit.hash;
        this.description = commit.date;
        this.tooltip = `Author: ${commit.author}\nHash: ${commit.hash}`;
        this.contextValue = 'snapshot';
        this.iconPath = new vscode.ThemeIcon('git-commit');
    }
}

export class SnapshotFile extends vscode.TreeItem {
    public readonly filePath: string;
    public readonly status: 'A' | 'M' | 'D' | 'R' | 'C';

    constructor(
        fileChange: FileChange,
        public readonly commitHash: string,
        workspaceRoot: string,
    ) {
        const filename = path.basename(fileChange.path);
        const dir = path.dirname(fileChange.path);

        super(filename, vscode.TreeItemCollapsibleState.None);
        
        this.filePath = fileChange.path;
        this.status = fileChange.status;
        this.description = dir === '.' ? '' : dir;
        this.contextValue = 'snapshotFile';

        // The resourceUri must be a unique, virtual representation of this specific version of the file.
        // This prevents conflicts with the on-disk file and ensures the diff command's context is clean.
        // The path must end with the filename for VS Code to show the correct file icon.
        this.resourceUri = vscode.Uri.from({
            scheme: 'workspace-snapshot',
            // The path itself is not used for data retrieval, but its structure helps with uniqueness and icons.
            path: `/${this.commitHash}/${this.filePath}`,
            // The query is used by the decoration provider to get the status.
            query: `status=${this.status}`
        });

        this.command = {
            command: 'workspace_snapshots.showDiff',
            title: 'Show Snapshot Diff',
            arguments: [this]
        };
    }
}
