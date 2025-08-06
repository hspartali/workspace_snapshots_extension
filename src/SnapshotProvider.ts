import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import { Commit, Git } from './Git';
import { Snapshot, SnapshotFile } from './Snapshot';

export class SnapshotProvider implements vscode.TreeDataProvider<Snapshot | SnapshotFile> {
    private _onDidChangeTreeData = new vscode.EventEmitter<Snapshot | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    public git!: Git;
    public workspaceRoot!: string;
    private shadowRepoPath!: string;
    private snapshotNames: Map<string, string> = new Map();
    private restoredSnapshotId: string | null = null;
    private deletedSnapshotIds: Set<string> = new Set();
    private _commitCache: Map<string, Commit> = new Map();

    constructor(private context: vscode.ExtensionContext) {}

    // --- Initialization & Setup ---

    public async initialize(): Promise<void> {
        this.workspaceRoot = this.getWorkspaceRoot();
        this.validateWorkspacePath();
        this.loadMetadata();

        const workspaceId = this.getWorkspaceId(this.workspaceRoot);
        this.shadowRepoPath = path.join(this.context.globalStorageUri.fsPath, workspaceId);

        this.git = new Git(this.shadowRepoPath, this.workspaceRoot);

        if (!fs.existsSync(path.join(this.shadowRepoPath, 'config'))) {
            await this.git.init();
            await this.git.createInitialCommit();
            vscode.window.showInformationMessage("Initialized new snapshot repository for this workspace.");
        }

        // Always ensure configuration and exclusions are set, making initialization resilient.
        await this.git.configure();
        await this.applyExclusions();
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
        const status = await this.git.getStatus();
        if (!status) {
            throw new Error("No changes detected since the last snapshot.");
        }
        await this.git.commit(message);
        
        // Creating a new snapshot invalidates any previously restored state.
        this.restoredSnapshotId = null;
        this.saveMetadata();
    }

    public async restoreSnapshot(hash: string): Promise<void> {
        await this.git.restore(hash);
        this.restoredSnapshotId = hash;
        this.saveMetadata();
    }

    public renameSnapshot(commitHash: string, newName: string): void {
        this.snapshotNames.set(commitHash, newName);
        this.saveMetadata();
    }

    public deleteSnapshot(commitHash: string): void {
        this.deletedSnapshotIds.add(commitHash);
        // If the deleted snapshot was the restored one, clear the restored state.
        if (this.restoredSnapshotId === commitHash) {
            this.restoredSnapshotId = null;
        }
        this.saveMetadata();
    }

    public async clearAllSnapshots(): Promise<void> {
        if (fs.existsSync(this.shadowRepoPath)) {
            await fs.promises.rm(this.shadowRepoPath, { recursive: true, force: true });
        }
        const metadataPath = this.getMetadataPath();
        if (fs.existsSync(metadataPath)) {
            await fs.promises.rm(metadataPath, { recursive: true, force: true });
        }
        // Re-initialize for immediate use, which will clear the in-memory state.
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
            
            // Cache the commits for faster lookups later
            this._commitCache.clear();
            commits.forEach(c => this._commitCache.set(c.hash, c));

            // The first commit is an implementation detail and should not be shown to the user.
            const userCommits = commits.filter(c => c.parentHash !== null && !this.deletedSnapshotIds.has(c.hash));
            return userCommits.map((commit, index) => {
                const customName = this.snapshotNames.get(commit.hash);
                const isRestored = commit.hash === this.restoredSnapshotId;
                // The newest snapshot is always the first one in the default log order.
                const isNew = userCommits.length > 0 && index === 0;
                return new Snapshot(commit, customName, isRestored, isNew);
            });
        }
    }

    // --- Diffing Logic ---

    private findVisibleParentHash(commitHash: string): string | null {
        let currentCommit = this._commitCache.get(commitHash);
    
        while (currentCommit) {
            const parentHash = currentCommit.parentHash;
    
            // Stop if we've reached the beginning of the history.
            if (!parentHash) {
                return null;
            }
    
            // If the parent is not in the set of deleted snapshots, we've found our target.
            if (!this.deletedSnapshotIds.has(parentHash)) {
                return parentHash;
            }
            
            // The parent was deleted, so continue searching up the tree from the parent.
            currentCommit = this._commitCache.get(parentHash);
        }
    
        return null;
    }

    async getDiffUris(item: Snapshot | SnapshotFile): Promise<{ left: vscode.Uri; right: vscode.Uri; title: string } | null> {
        if (!(item instanceof SnapshotFile)) {
            // We can only diff individual files.
            return null;
        }

        const filePath = item.filePath;
        const commitHash = item.commitHash;

        const getSnapshotName = (hash: string | null): string => {
            if (!hash) {
                return 'Base';
            }
            const customName = this.snapshotNames.get(hash);
            if (customName) {
                return customName;
            }
            const commit = this._commitCache.get(hash);
            return commit ? commit.message : hash.substring(0, 7);
        };

        const rightUri = vscode.Uri.from({
            scheme: 'workspace-snapshot',
            path: `/${filePath}`,
            query: `commit=${commitHash}`
        });
        const rightName = getSnapshotName(commitHash);

        let leftUri: vscode.Uri;
        let leftName: string;

        const diffAgainstWorkspace = vscode.workspace.getConfiguration('workspaceSnapshots').get<boolean>('diffAgainstWorkspace');

        if (diffAgainstWorkspace) {
            leftUri = vscode.Uri.file(path.join(this.workspaceRoot, filePath));
            leftName = 'Workspace';
        } else {
            const parentHash = this.findVisibleParentHash(commitHash);
            leftUri = vscode.Uri.from({
                scheme: 'workspace-snapshot',
                path: `/${filePath}`,
                query: `commit=${parentHash || 'none'}`
            });
            leftName = getSnapshotName(parentHash);
        }

        const title = `${path.basename(filePath)} (${leftName} ↔ ${rightName})`;
        
        return { left: leftUri, right: rightUri, title };
    }

    // --- Metadata Storage ---

    private getMetadataPath(): string {
        const workspaceId = this.getWorkspaceId(this.workspaceRoot);
        return path.join(this.context.globalStorageUri.fsPath, `${workspaceId}-metadata.json`);
    }

    private loadMetadata(): void {
        const metadataPath = this.getMetadataPath();
        if (fs.existsSync(metadataPath)) {
            try {
                const content = fs.readFileSync(metadataPath, 'utf-8');
                const data = JSON.parse(content);
                this.snapshotNames = new Map(Object.entries(data.names || {}));
                this.restoredSnapshotId = data.restoredSnapshotId || null;
                this.deletedSnapshotIds = new Set(data.deletedIds || []);
            } catch (e) {
                console.error("Failed to load snapshot metadata", e);
                this.snapshotNames = new Map();
                this.restoredSnapshotId = null;
                this.deletedSnapshotIds = new Set();
            }
        }
    }

    private saveMetadata(): void {
        const metadataPath = this.getMetadataPath();
        const data = {
            names: Object.fromEntries(this.snapshotNames),
            restoredSnapshotId: this.restoredSnapshotId,
            deletedIds: Array.from(this.deletedSnapshotIds),
        };
        fs.writeFileSync(metadataPath, JSON.stringify(data, null, 2));
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
