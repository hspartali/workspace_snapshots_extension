import * as vscode from 'vscode';
import { exec } from 'child_process';
import * as path from 'path';

export class Git {
    private repoRoot: string | null = null;

    constructor() {
        this.findRepoRoot();
    }

    private async execute(command: string): Promise<string> {
        return new Promise((resolve, reject) => {
            if (!this.repoRoot) {
                return reject(new Error("Not in a git repository."));
            }
            exec(command, { cwd: this.repoRoot }, (error, stdout, stderr) => {
                if (error) {
                    return reject(new Error(`Git command failed: ${stderr || error.message}`));
                }
                resolve(stdout.trim());
            });
        });
    }

    private findRepoRoot() {
        const workspaceFolders = vscode.workspace.workspaceFolders;
        if (workspaceFolders && workspaceFolders.length > 0) {
            this.repoRoot = workspaceFolders[0].uri.fsPath; // Simplification: assumes first folder is root
        }
    }

    public getRepoRoot(): string {
        if (!this.repoRoot) {
            throw new Error("Could not find git repository root.");
        }
        return this.repoRoot;
    }

    public async checkIsRepo(): Promise<void> {
        try {
            await this.execute('git rev-parse --is-inside-work-tree');
        } catch (error) {
            throw new Error("The current workspace is not a git repository.");
        }
    }

    public async getStagedFiles(): Promise<string[]> {
        const output = await this.execute('git diff --name-only --cached');
        return output ? output.split('\n') : [];
    }

    public async createPatchFromIndex(patchPath: string): Promise<void> {
        // Using `>` is tricky with child_process, so we pipe it.
        const command = `git diff --cached > "${patchPath}"`;
        await this.execute(command);
    }
    
    public async applyPatch(patchPath: string): Promise<void> {
        // --reject ensures that patch application doesn't stop on first error
        await this.execute(`git apply --reject "${patchPath}"`);
    }

    public async resetHard(): Promise<void> {
        await this.execute('git reset --hard HEAD');
    }
    
    public async stash(): Promise<boolean> {
        const output = await this.execute('git stash push -m "changelayer-temp-stash"');
        return !output.includes("No local changes to save");
    }

    public async stashPop(): Promise<void> {
        try {
            await this.execute('git stash pop');
        } catch (error) {
            // Ignore error if nothing to pop
            console.warn("Could not pop stash, it might have been empty.", error);
        }
    }
}
