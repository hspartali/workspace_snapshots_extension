import * as vscode from 'vscode';
import { Git } from './Git';

export class ReadonlyContentProvider implements vscode.TextDocumentContentProvider {
    constructor(private git: Git) {}

    async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
        // The file path is the URI path, and the version is in the query.
        const query = new URLSearchParams(uri.query);
        const commitHash = query.get('commit');
        const filePath = uri.path.substring(1); // Remove leading '/'

        if (!commitHash || commitHash === 'none' || !filePath) {
            // If any component is missing, or commit is 'none', return empty content.
            return '';
        }

        try {
            return await this.git.show(commitHash, filePath);
        } catch (error: any) {
            console.error(`Failed to get content for ${filePath} at ${commitHash}: ${error.message}`);
            // Return empty string if git show fails (e.g., file not in commit)
            return '';
        }
    }
}
