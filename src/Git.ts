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
    status: 'A' | 'M' | 'D';
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

    public async stageFile(filePath: string): Promise<void> {
        await this.execute(`add -- "${filePath.replace(/"/g, '\\"')}"`);
    }

    public async commit(message: string): Promise<string> {
        // Use --no-verify to bypass any potential user-defined hooks in their global git config
        await this.execute(`commit --no-verify -m "${message.replace(/"/g, '\\"')}"`);
        // Return the hash of the new commit directly.
        return this.execute('rev-parse HEAD');
    }

    public async amendCommit(): Promise<string> {
        // Use --no-verify to bypass hooks and --no-edit to keep the previous commit message.
        await this.execute(`commit --no-verify --amend --no-edit`);
        // Return the hash of the new (amended) commit.
        return this.execute('rev-parse HEAD');
    }

    public async getStatus(): Promise<FileChange[]> {
        const statusOutput = await this.execute('status --porcelain -uall');
        if (!statusOutput) {
            return [];
        }

        const lines = statusOutput
            .split(/\r?\n/)                     // split by newlines handling both LF and CRLF line endings
            .filter(line => line.length > 0);    // remove empty lines

        return lines.map(line => {
                // Trim spaces, remove ("") as git might add them if file name has spaces, and split by whitespace
                const trimmedLine = line.trim().replace(/"/g, "");
                const firstSpaceIndex = trimmedLine.indexOf(' ');
                const statusChar = trimmedLine.slice(0, firstSpaceIndex);
                const filePath = trimmedLine.slice(firstSpaceIndex + 1).trim();

                // We map staged/unstaged changes to simpler statuses. 'A' for new, 'D' for deleted, 'M' for everything else.
                let status: 'A' | 'M' | 'D';
                if (statusChar.startsWith('A') || statusChar === '??') {
                    status = 'A';
                } else if (statusChar.startsWith('D')) {
                    status = 'D';
                } else {
                    status = 'M';
                }
                return { status, path: filePath };
            });
    }

    public async getCommits(): Promise<Commit[]> {
        try {
            // Using a custom format to easily parse the log output, including the parent hash (%P).
            // Commits are listed newest-to-oldest by default. We use --reverse to show oldest first.
            const format = `%H%x1F%P%x1F%s%x1F%an%x1F%ar`; // hash, parent hashes, subject, author, date
            const logOutput = await this.execute(`log --reverse --pretty=format:"${format}"`);
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

        const changes: FileChange[] = [];
        const lines = diffOutput.split('\n').filter(line => line.trim());

        for (const line of lines) {
            const parts = line.split('\t');
            const statusChar = parts[0].charAt(0);

            if (statusChar === 'R' || statusChar === 'C') {
                // Treat rename/copy as delete of old path + add of new path
                changes.push({ status: 'D', path: parts[1] });
                changes.push({ status: 'A', path: parts[2] });
            } else if (statusChar === 'A') {
                changes.push({ status: 'A', path: parts[1] });
            } else if (statusChar === 'D') {
                changes.push({ status: 'D', path: parts[1] });
            } else { // M (Modified), T (Type change), etc. are all treated as Modified
                changes.push({ status: 'M', path: parts[1] });
            }
        }
        return changes;
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

    public async getTrackedFiles(hash: string): Promise<string[]> {
        // ls-tree is a reliable, low-level way to get a flat list of all files in a commit.
        const output = await this.execute(`ls-tree -r --name-only ${hash}`);
        if (!output) {
            return [];
        }
        return output.split(/\r?\n/).filter(line => line.length > 0);
    }

    public async discard(filePath: string): Promise<void> {
        // Discard changes in the working tree for a specific file.
        await this.execute(`restore -- "${filePath.replace(/"/g, '\\"')}"`);
    }

    public async discardAll(): Promise<void> {
        // Discard all changes in the working tree for tracked files.
        await this.execute(`restore .`);
    }

    public async resetHead(hash: string): Promise<void> {
        // --soft moves HEAD but doesn't touch the index file or the working tree, which is exactly what we need.
        // The user's changes in the working directory are preserved and will be compared against the new HEAD.
        await this.execute(`reset --soft ${hash}`);
    }

    public async getHeadHash(): Promise<string> {
        // We just need the hash of what HEAD points to.
        return this.execute('rev-parse HEAD');
    }
}
