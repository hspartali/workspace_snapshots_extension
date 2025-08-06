import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import { Git } from './Git';
import { Snapshot, SnapshotFile } from './Snapshot';

export class SnapshotProvider implements vscode.TreeDataProvider<Snapshot | SnapshotFile> {
    private _onDidChangeTreeData = new vscode.EventEmitter<Snapshot | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    public git!: Git;
    public workspaceRoot!: string;
    private shadowRepoPath!: string;

    constructor(private context: vscode.ExtensionContext) {}

    // --- Initialization & Setup ---

    public async initialize(): Promise<void> {
        this.workspaceRoot = this.getWorkspaceRoot();
        this.validateWorkspacePath();

        const workspaceId = this.getWorkspaceId(this.workspaceRoot);
        this.shadowRepoPath = path.join(this.context.globalStorageUri.fsPath, workspaceId);

        this.git = new Git(this.shadowRepoPath, this.workspaceRoot);

        if (!fs.existsSync(path.join(this.shadowRepoPath, 'config'))) {
            await this.git.init();
            await this.git.configure();
            await this.applyExclusions();
            await this.git.createInitialCommit();
            vscode.window.showInformationMessage("Initialized new snapshot repository for this workspace.");
        }
    }

    private getWorkspaceRoot(): string {
        if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
            throw new Error('No workspace folder is open.');
        }
        return vscode.workspace.workspaceFolders[0].uri.fsPath;
    }

    private validateWorkspacePath(): void {
        const homeDir = os.homedir();
        const sensitivePaths = [
            homeDir,
            path.join(homeDir, 'Desktop'),
            path.join(homeDir, 'Documents'),
            path.join(homeDir, 'Downloads'),
        ];

        if (sensitivePaths.includes(path.normalize(this.workspaceRoot))) {
            throw new Error(`For safety, Workspace Snapshots cannot be activated on sensitive directories like '${this.workspaceRoot}'. Please use it within a specific project folder.`);
        }
    }
    
    private getWorkspaceId(workspacePath: string): string {
        return crypto.createHash('sha256').update(workspacePath).digest('hex');
    }

    // --- Core Functionality ---

    public async createSnapshot(message: string): Promise<void> {
        await this.git.stageAll();
        await this.git.commit(message);
    }

    public async restoreSnapshot(hash: string): Promise<void> {
        await this.git.restore(hash);
    }

    public async clearAllSnapshots(): Promise<void> {
        if (fs.existsSync(this.shadowRepoPath)) {
            await fs.promises.rm(this.shadowRepoPath, { recursive: true, force: true });
        }
        // Re-initialize for immediate use
        await this.initialize();
    }

    // --- Tree Data Provider Implementation ---

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: Snapshot | SnapshotFile): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: Snapshot): Promise<(Snapshot | SnapshotFile)[] | null | undefined> {
        if (!this.git) {
            await this.initialize();
        }
        
        if (element) {
            // Get changed files for a specific snapshot
            const files = await this.git.getChangedFiles(element.id!);
            return files.map(file => new SnapshotFile(file, element.id!, this.workspaceRoot));
        } else {
            // Get all snapshots (commits)
            const commits = await this.git.getCommits();
            // The first commit is an implementation detail and should not be shown to the user.
            const userCommits = commits.filter(c => c.message !== "Initial snapshot repository");
            return userCommits.map(commit => new Snapshot(commit));
        }
    }

    // --- Diffing Logic ---

    async getDiffUris(item: Snapshot | SnapshotFile): Promise<{ left: vscode.Uri; right: vscode.Uri; title: string } | null> {
        if (!(item instanceof SnapshotFile)) {
            // We can only diff individual files.
            return null;
        }

        const filePath = item.filePath;
        const commitHash = item.commitHash;
        const parentHash = await this.git.getParentHash(commitHash);

        // The URI path identifies the file, and the query identifies the version (commit).
        const leftUri = vscode.Uri.from({
            scheme: 'workspace-snapshot',
            path: `/${filePath}`,
            query: `commit=${parentHash || 'none'}`
        });

        const rightUri = vscode.Uri.from({
            scheme: 'workspace-snapshot',
            path: `/${filePath}`,
            query: `commit=${commitHash}`
        });

        const title = `${path.basename(filePath)} (${parentHash ? parentHash.substring(0, 7) : 'Base'} ↔ ${commitHash.substring(0, 7)})`;
        
        return { left: leftUri, right: rightUri, title };
    }

    // --- Exclusion Management ---

    private async applyExclusions(): Promise<void> {
        const patterns = await this.getExclusionPatterns();
        const excludeFile = path.join(this.shadowRepoPath, 'info', 'exclude');
        fs.writeFileSync(excludeFile, patterns.join('\n'));
    }

    private async getExclusionPatterns(): Promise<string[]> {
        // A comprehensive default list.
        const defaultPatterns = [
            // Self
            '/.git/',
            '/.git_snapshot_disabled/',
            // Common
            'node_modules/',
            '__pycache__/',
            '*.pyc', '*.pyo', '*.pyd',
            '.DS_Store',
            // Build output
            '/build/',
            '/dist/',
            '/out/',
            '/target/',
            // Logs
            '*.log',
            'npm-debug.log*',
            'yarn-debug.log*',
            'yarn-error.log*',
            // Env
            '.env*',
            '!.env.example',
            // VS Code
            '/.vscode/',
            // Large files
            '*.zip', '*.rar', '*.7z', '*.tar', '*.gz',
            '*.mp4', '*.mov', '*.avi', '*.mkv',
            '*.mp3', '*.wav', '*.ogg',
            '*.jpg', '*.jpeg', '*.png', '*.gif', '*.bmp',
        ];

        // Add user's own .gitignore if it exists
        const userGitignorePath = path.join(this.workspaceRoot, '.gitignore');
        if (fs.existsSync(userGitignorePath)) {
            const userPatterns = fs.readFileSync(userGitignorePath, 'utf-8').split(/\r?\n/);
            return [...defaultPatterns, ...userPatterns.filter(p => p && !p.startsWith('#'))];
        }

        return defaultPatterns;
    }
}
