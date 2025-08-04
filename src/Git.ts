import * as vscode from 'vscode';
import { exec } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

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
                // Do NOT trim the output here. Trimming can corrupt patch files.
                // Callers are responsible for processing the raw output.
                resolve(stdout);
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

    public async getChangedFiles(): Promise<string[]> {
        // This gets all changed files (staged and unstaged)
        const output = await this.execute('git diff --name-only HEAD');
        const trimmedOutput = output.trim();
        return trimmedOutput ? trimmedOutput.split('\n') : [];
    }

    public async getFileContentAtHead(filePath: string): Promise<string> {
        try {
            return await this.execute(`git show HEAD:"${filePath}"`);
        } catch (error) {
            // File likely didn't exist at HEAD, which is a valid state
            return '';
        }
    }

    public async checkoutFiles(files: string[]): Promise<void> {
        if (files.length === 0) {
            return;
        }
        // Quote files to handle paths with spaces
        const quotedFiles = files.map(f => `"${f}"`).join(' ');
        await this.execute(`git checkout -- ${quotedFiles}`);
    }
}
