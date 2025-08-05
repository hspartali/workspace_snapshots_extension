import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Git } from './Git';

export class ReadonlyContentProvider implements vscode.TextDocumentContentProvider {

    constructor(private git: Git) {}

    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        const query = new URLSearchParams(uri.query);
        // The path in the URI is the exact file path we need, no substring required.
        const filePath = uri.path;
        const workspaceRoot = vscode.workspace.workspaceFolders![0].uri.fsPath;

        if (query.has('head')) {
            // Content is from HEAD
            return this.git.getFileContentAtHead(filePath);
        }

        if (query.has('snapshotId')) {
            // Content is from a snapshot
            const snapshotId = query.get('snapshotId')!;
            const snapshotPath = path.join(workspaceRoot, '.vscode', 'workspace_snapshots', snapshotId, filePath);
            if (fs.existsSync(snapshotPath)) {
                return fs.readFileSync(snapshotPath, 'utf-8');
            }
        }
        
        // Return empty string if no content could be found (e.g. file was created new in a snapshot)
        return '';
    }
}
