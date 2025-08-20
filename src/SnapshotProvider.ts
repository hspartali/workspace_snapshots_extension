import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import * as os from 'os';
import { Commit, FileChange, Git } from './Git';
import { Snapshot, SnapshotFile, SeparatorItem, ChangesItem, WorkspaceFileChangeItem } from './Snapshot';

type TreeItem = Snapshot | SnapshotFile | SeparatorItem | ChangesItem | WorkspaceFileChangeItem;

export class SnapshotProvider implements vscode.TreeDataProvider<TreeItem> {
    private _onDidChangeTreeData = new vscode.EventEmitter<TreeItem | undefined | null | void>();
    readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

    public git!: Git;
    public workspaceRoot!: string;
    private shadowRepoPath!: string;
    private snapshotNames: Map<string, string> = new Map();
    private separatorNames: Map<string, string> = new Map();
    private restoredSnapshotId: string | null = null;
    private deletedSnapshotIds: Set<string> = new Set();
    private _commitCache: Map<string, Commit> = new Map();
    private treeView?: vscode.TreeView<TreeItem>;

    constructor(private context: vscode.ExtensionContext) {}

    public setTreeView(treeView: vscode.TreeView<TreeItem>): void {
        this.treeView = treeView;
    }

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
        await this.refresh();
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
        // Truncate the full SHA256 hash to 16 characters for a shorter, yet still highly unique, directory name.
        // This avoids potential MAX_PATH issues on Windows without a significant risk of collision.
        return crypto.createHash('sha256').update(workspacePath).digest('hex').substring(0, 16);
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

    public async addSeparator(name: string): Promise<void> {
        const commits = await this.git.getCommits();
        const userCommits = commits.filter(c => c.parentHash !== null && !this.deletedSnapshotIds.has(c.hash));
        if (userCommits.length > 0) {
            // Get the last commit in the list, which is the newest one with --reverse
            const latestCommitHash = userCommits[userCommits.length - 1].hash;
            this.separatorNames.set(latestCommitHash, name);
            this.saveMetadata();
        } else {
            vscode.window.showWarningMessage("Cannot add separator: No snapshots found.");
        }
    }

    public renameSeparator(commitHash: string, newName: string): void {
        this.separatorNames.set(commitHash, newName);
        this.saveMetadata();
    }

    public deleteSeparator(commitHash: string): void {
        this.separatorNames.delete(commitHash);
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

    public async refresh(): Promise<void> {
        await this.updateBadge();
        this._onDidChangeTreeData.fire();
    }

    private async updateBadge(): Promise<void> {
        if (this.treeView && this.git) {
            const changes = await this.git.getStatus();
            const changeCount = changes.length;
            if (changeCount > 0) {
                this.treeView.badge = {
                    value: changeCount,
                    tooltip: `${changeCount} uncommitted changes`
                };
            } else {
                this.treeView.badge = undefined;
            }
        }
    }

    getTreeItem(element: TreeItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: TreeItem): Promise<TreeItem[]> {
        try {
            if (!this.git) {
                // This can happen on startup. Return empty and let the initialization call refresh.
                return [];
            }

            if (element) {
                if (element instanceof Snapshot) {
                    const files = await this.git.getChangedFiles(element.id!);
                    return files.map(file => new SnapshotFile(file, element.id!, this.workspaceRoot));
                }
                if (element instanceof ChangesItem) {
                    const changes = await this.git.getStatus();
                    return changes.map(change => new WorkspaceFileChangeItem(change, this.workspaceRoot));
                }
                return []; // Other elements are leaves
            } else {
                // Root elements
                const commits = await this.git.getCommits();
                this._commitCache.clear();
                commits.forEach(c => this._commitCache.set(c.hash, c));
                const userCommits = commits.filter(c => c.parentHash !== null && !this.deletedSnapshotIds.has(c.hash));

                const snapshotItems: (Snapshot | SeparatorItem)[] = userCommits.flatMap((commit, index) => {
                    const results: (Snapshot | SeparatorItem)[] = [];
                    const separatorName = this.separatorNames.get(commit.hash);
                    if (separatorName) {
                        results.push(new SeparatorItem(separatorName, commit.hash));
                    }

                    const customName = this.snapshotNames.get(commit.hash);
                    const isRestored = commit.hash === this.restoredSnapshotId;
                    const isNew = userCommits.length > 0 && index === userCommits.length - 1;
                    results.push(new Snapshot(commit, customName, isRestored, isNew));
                    return results;
                });

                // Add the "Changes" container at the end.
                const changesItem = new ChangesItem();
                return [...snapshotItems, changesItem];
            }
        } catch (error: any) {
            console.error("Error providing tree data for Workspace Snapshots:", error);
            // Avoid showing an error message on every refresh, log it instead.
            return [];
        }
    }

    // --- Diffing Logic ---

    public async getWorkspaceDiffUris(item: WorkspaceFileChangeItem): Promise<{ left: vscode.Uri; right: vscode.Uri; title: string } | null> {
        const commits = await this.git.getCommits();
        const userCommits = commits.filter(c => c.parentHash !== null && !this.deletedSnapshotIds.has(c.hash));

        if (userCommits.length === 0) {
            vscode.window.showWarningMessage("Cannot diff changes: No snapshots have been created yet.");
            return null;
        }
        
        const latestCommitHash = userCommits[userCommits.length - 1].hash;
        const filePath = item.filePath;

        const leftUri = vscode.Uri.from({
            scheme: 'workspace-snapshot',
            path: `/${filePath}`,
            query: `commit=${latestCommitHash}`
        });

        // The right URI is the actual editable file in the workspace
        const rightUri = vscode.Uri.file(path.join(this.workspaceRoot, filePath));

        const title = `${path.basename(filePath)} (Latest Snapshot ↔ Workspace)`;

        return { left: leftUri, right: rightUri, title };
    }

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
        // Check for the properties we need, instead of a strict class instance.
        // This allows us to re-create diffs from plain objects during the refresh process.
        if (!item || !('filePath' in item) || !('commitHash' in item) || typeof item.filePath !== 'string' || typeof item.commitHash !== 'string') {
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
                this.separatorNames = new Map(Object.entries(data.separators || {}));
                this.restoredSnapshotId = data.restoredSnapshotId || null;
                this.deletedSnapshotIds = new Set(data.deletedIds || []);
            } catch (e) {
                console.error("Failed to load snapshot metadata", e);
                this.snapshotNames = new Map();
                this.separatorNames = new Map();
                this.restoredSnapshotId = null;
                this.deletedSnapshotIds = new Set();
            }
        }
    }

    private saveMetadata(): void {
        const metadataPath = this.getMetadataPath();
        const data = {
            names: Object.fromEntries(this.snapshotNames),
            separators: Object.fromEntries(this.separatorNames),
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
