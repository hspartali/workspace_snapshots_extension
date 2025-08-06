import * as vscode from 'vscode';
import { exec, ExecOptions } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface Commit {
    hash: string;
    parentHash: string | null;
    message: string;
    author: string;
    date: string;
}

export interface FileChange {
    path: string;
    status: 'A' | 'M' | 'D' | 'R' | 'C';
}

export class Git {
    constructor(
        private readonly gitDir: string,
        private readonly workTree: string
    ) {}

    private async execute(command: string, options: ExecOptions = {}): Promise<string> {
        // Essential: All git commands must operate on the shadow repo and user's work tree.
        const fullCommand = `git --git-dir="${this.gitDir}" --work-tree="${this.workTree}" ${command}`;
        
        return new Promise((resolve, reject) => {
            exec(fullCommand, options, (error, stdout, stderr) => {
                if (error) {
                    // Combine stderr and error message for a more informative failure message.
                    const errorMessage = `Git command failed: ${command}\n${stderr}\n${error.message}`;
                    return reject(new Error(errorMessage));
                }
                resolve(stdout.trim());
            });
        });
    }

    public async init(): Promise<void> {
        // This is a special case; --git-dir is the directory to create.
        if (fs.existsSync(this.gitDir)) {
            return;
        }
        fs.mkdirSync(this.gitDir, { recursive: true });
        await this.execute(`init`);
    }

    public async configure(): Promise<void> {
        await this.execute('config user.name "Workspace Snapshots"');
        await this.execute('config user.email "snapshots@vscode.ext"');
        await this.execute('config commit.gpgSign false'); // Ensure no GPG signing prompts
    }

    public async createInitialCommit(): Promise<string> {
        return this.execute('commit --allow-empty -m "Initial snapshot repository"');
    }

    public async stageAll(): Promise<void> {
        await this.execute('add -A .');
    }

    public async commit(message: string): Promise<string> {
        // Use --no-verify to bypass any potential user-defined hooks in their global git config
        await this.execute(`commit --no-verify -m "${message.replace(/"/g, '\\"')}"`);
        // Return the hash of the new commit directly.
        return this.execute('rev-parse HEAD');
    }

    public async getCommits(): Promise<Commit[]> {
        try {
            // Using a custom format to easily parse the log output, including the parent hash (%P).
            // Commits are listed newest-to-oldest by default.
            const format = `%H%x1F%P%x1F%s%x1F%an%x1F%ar`; // hash, parent hashes, subject, author, date
            const logOutput = await this.execute(`log --pretty=format:"${format}"`);
            if (!logOutput) {
                return [];
            }
            return logOutput.split('\n').map(line => {
                const [hash, parentHashes, message, author, date] = line.split('\x1F');
                // A commit can have multiple parents in a merge, but we only care about the first one.
                const parentHash = parentHashes.split(' ')[0] || null;
                return { hash, parentHash, message, author, date };
            });
        } catch (error) {
            // If the repo is empty (e.g., just initialized), log will fail.
            return [];
        }
    }

    public async getChangedFiles(hash: string): Promise<FileChange[]> {
        // Use `git show` which works for any commit, including the initial one.
        const diffOutput = await this.execute(`show --name-status --pretty="" ${hash}`);
        if (!diffOutput) {
            return [];
        }

        return diffOutput.split('\n')
            .filter(line => line.trim()) // Filter out potential empty lines
            .map(line => {
                const [status, filePath] = line.split('\t');
                return { status: status as 'A' | 'M' | 'D', path: filePath };
            });
    }
    
    public async show(hash: string, filePath: string): Promise<string> {
        try {
            return await this.execute(`show ${hash}:"${filePath.replace(/"/g, '\\"')}"`);
        } catch (e) {
            // If `git show` fails, it's likely because the file didn't exist in that commit (e.g., added later or deleted before).
            return '';
        }
    }

    public async restore(hash: string): Promise<void> {
        // This command is the key to non-destructive restores.
        // It updates the working directory to match the commit, but DOES NOT move HEAD.
        await this.execute(`restore --source=${hash} --worktree -- .`);
    }

}
