import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Snapshot, SnapshotFile } from './Snapshot';
import { Git } from './Git';

interface SnapshotData {
    id: string;
    label: string;
    timestamp: number;
    changedFiles: { path: string, status: 'A' | 'M' | 'D' }[];
}

export class SnapshotProvider implements vscode.TreeDataProvider<Snapshot | SnapshotFile> {
    private _onDidChangeTreeData: vscode.EventEmitter<Snapshot | undefined | null | void> = new vscode.EventEmitter<Snapshot | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<Snapshot | undefined | null | void> = this._onDidChangeTreeData.event;

    private snapshots: Snapshot[] = [];

    constructor(private context: vscode.ExtensionContext, private git: Git) {
        this.loadSnapshotsFromMetadata();
    }

    refresh(): void {
        this.loadSnapshotsFromMetadata();
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: Snapshot | SnapshotFile): vscode.TreeItem {
        return element;
    }

    getChildren(element?: Snapshot): vscode.ProviderResult<Snapshot[] | SnapshotFile[]> {
        if (element) {
            return element.getFiles();
        } else {
            return this.snapshots.filter(snapshot => snapshot.changedFiles.length > 0);
        }
    }

    public getSnapshotById(id: string): Snapshot | undefined {
        return this.snapshots.find(l => l.id === id);
    }

    // --- Storage and Metadata ---

    private getWorkspaceRoot(): string {
        if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
            throw new Error('No workspace folder open.');
        }
        return vscode.workspace.workspaceFolders[0].uri.fsPath;
    }

    private getSnapshotsRootPath(): string {
        return path.join(this.getWorkspaceRoot(), '.vscode', 'workspace_snapshots');
    }

    private getMetadataPath(): string {
        return path.join(this.getSnapshotsRootPath(), 'metadata.json');
    }

    private loadSnapshotsFromMetadata() {
        try {
            if (!fs.existsSync(this.getMetadataPath())) {
                this.snapshots = [];
                return;
            }
            const metadataContent = fs.readFileSync(this.getMetadataPath(), 'utf-8');
            const snapshotsData: any[] = JSON.parse(metadataContent);
            this.snapshots = snapshotsData.map(data => {
                const changedFiles = data.changedFiles.map((file: any) => {
                    if (typeof file === 'string') {
                        // Backwards compatibility for old metadata format
                        return { path: file, status: 'M' };
                    }
                    return file;
                });
                return new Snapshot(data.label, data.id, data.timestamp, changedFiles);
            });
            this.snapshots.sort((a, b) => a.timestamp - b.timestamp);
        } catch (error) {
            console.error("Failed to load snapshots metadata", error);
            this.snapshots = [];
        }
    }

    private saveMetadata() {
        const snapshotsData = this.snapshots.map(snapshot => ({
            id: snapshot.id,
            label: snapshot.label,
            timestamp: snapshot.timestamp,
            changedFiles: snapshot.changedFiles
        }));
        if (!fs.existsSync(this.getSnapshotsRootPath())) {
            fs.mkdirSync(this.getSnapshotsRootPath(), { recursive: true });
        }
        fs.writeFileSync(this.getMetadataPath(), JSON.stringify(snapshotsData, null, 2));
    }

    public isLastChangeForFile(file: SnapshotFile): boolean {
        const targetSnapshotIndex = this.snapshots.findIndex(l => l.id === file.snapshot.id);
        if (targetSnapshotIndex === -1) {
            return true; // Should not happen, but safer to assume it's the last.
        }
        const filePath = file.label;
        // Search in snapshots *after* the current one.
        return !this.snapshots
            .slice(targetSnapshotIndex + 1)
            .some(l => l.changedFiles.some(f => f.path === filePath));
    }

    public async discardOrRemoveFileFromSnapshot(file: SnapshotFile): Promise<void> {
        const isLastChange = this.isLastChangeForFile(file);

        if (isLastChange) {
            // DISCARD logic: Revert the live file
            const targetSnapshotIndex = this.snapshots.findIndex(l => l.id === file.snapshot.id);
            if (targetSnapshotIndex === -1) { return; }

            const filePath = file.label;
            const { content: previousContent, existed: fileExistedBefore } = await this.getPreviousStateContent(filePath, file.snapshot.id);
            const workspaceFilePath = path.join(this.getWorkspaceRoot(), filePath);

            if (fileExistedBefore) {
                // Revert file to previous state
                const previousStateInfo = this.getPreviousStateInfo(targetSnapshotIndex, filePath);
                if (previousStateInfo.source === 'head') {
                    await this.git.checkoutFiles([filePath]);
                } else {
                    fs.writeFileSync(workspaceFilePath, previousContent!);
                }
            } else {
                // File didn't exist before, so delete it
                if (fs.existsSync(workspaceFilePath)) {
                    fs.unlinkSync(workspaceFilePath);
                }
            }
        }

        // For both cases (discard or remove), remove the file from this snapshot's metadata and snapshot file.
        this.removeFileFromSnapshotInternal(file);

        this.saveMetadata();
    }

    private removeFileFromSnapshotInternal(file: SnapshotFile) {
        const snapshot = this.snapshots.find(l => l.id === file.snapshot.id);
        if (!snapshot) {
            return;
        }
        const fileIndex = snapshot.changedFiles.findIndex(f => f.path === file.label);
        if (fileIndex > -1) {
            snapshot.changedFiles.splice(fileIndex, 1);

            // Also remove the snapshot file to keep storage clean
            const snapshotFilePath = path.join(this.getSnapshotsRootPath(), snapshot.id, file.label);
            if (fs.existsSync(snapshotFilePath)) {
                fs.unlinkSync(snapshotFilePath);
            }

            // If this was the last file in the snapshot, clean up the snapshot's now-empty directory.
            if (snapshot.changedFiles.length === 0) {
                const snapshotDir = path.join(this.getSnapshotsRootPath(), snapshot.id);
                if (fs.existsSync(snapshotDir)) {
                    fs.rmSync(snapshotDir, { recursive: true, force: true });
                }
            }
        }
    }

    // --- Core Functionality ---

    private async getPreviousState(filePath: string): Promise<{ content: string | null, existed: boolean }> {
        // Search backwards from the last snapshot to find the most recent state of the file
        for (let i = this.snapshots.length - 1; i >= 0; i--) {
            const snapshot = this.snapshots[i];
            const change = snapshot.changedFiles.find(f => f.path === filePath);
            if (change) {
                // We found the last time this file was changed in a snapshot
                if (change.status === 'D') {
                    // It was deleted, so it didn't exist before the current changes.
                    return { content: null, existed: false };
                }
                // It was Added or Modified, so its content is in this snapshot's file copy.
                const snapshotFilePath = path.join(this.getSnapshotsRootPath(), snapshot.id, filePath);
                if (fs.existsSync(snapshotFilePath)) {
                    return { content: fs.readFileSync(snapshotFilePath, 'utf-8'), existed: true };
                }
                // This case (A/M change without a file copy) would indicate a problem,
                // but we'll treat it as if the file didn't exist.
                return { content: null, existed: false };
            }
        }

        // If the file was never seen in any snapshot, its state is determined by HEAD.
        const existedAtHead = await this.git.fileExistsAtHead(filePath);
        if (existedAtHead) {
            const content = await this.git.getFileContentAtHead(filePath);
            return { content, existed: true };
        }

        // If not in snapshots and not in HEAD, it didn't exist.
        return { content: null, existed: false };
    }

    async createSnapshot(label: string): Promise<void> {
        await this.git.checkIsRepo();
        // Get a reliable list of all files that are new, modified, or deleted.
        const potentiallyChangedFiles = await this.git.getPotentiallyChangedFiles();
        const filesToSnapshot: { path: string, status: 'A' | 'M' | 'D' }[] = [];

        if (potentiallyChangedFiles.length === 0) {
            throw new Error('No changes detected to create a snapshot from.');
        }

        const newSnapshotId = Date.now().toString();
        const newSnapshotFilesPath = path.join(this.getSnapshotsRootPath(), newSnapshotId);
        fs.mkdirSync(newSnapshotFilesPath, { recursive: true });

        for (const file of potentiallyChangedFiles) {
            const workspaceFilePath = path.join(this.getWorkspaceRoot(), file);
            const fileCurrentlyExists = fs.existsSync(workspaceFilePath);
            const currentContent = fileCurrentlyExists ? fs.readFileSync(workspaceFilePath, 'utf-8') : null;

            const { content: previousContent, existed: fileExistedBefore } = await this.getPreviousState(file);

            if (fileCurrentlyExists) {
                if (!fileExistedBefore) {
                    // State change: Non-existent -> Existent. This is an ADDITION.
                    filesToSnapshot.push({ path: file, status: 'A' });
                    const destPath = path.join(newSnapshotFilesPath, file);
                    fs.mkdirSync(path.dirname(destPath), { recursive: true });
                    fs.writeFileSync(destPath, currentContent!);
                } else if (currentContent !== previousContent) {
                    // State change: Existent -> Existent (but different content). This is a MODIFICATION.
                    filesToSnapshot.push({ path: file, status: 'M' });
                    const destPath = path.join(newSnapshotFilesPath, file);
                    fs.mkdirSync(path.dirname(destPath), { recursive: true });
                    fs.writeFileSync(destPath, currentContent!);
                }
            } else { // File does not currently exist in the workspace.
                if (fileExistedBefore) {
                    // State change: Existent -> Non-existent. This is a DELETION.
                    filesToSnapshot.push({ path: file, status: 'D' });
                    // No snapshot file is written for deletions.
                }
            }
        }

        if (filesToSnapshot.length === 0) {
            throw new Error('No effective changes detected since the last snapshot or HEAD.');
        }

        const newSnapshot = new Snapshot(label, newSnapshotId, parseInt(newSnapshotId, 10), filesToSnapshot);
        this.snapshots.push(newSnapshot);
        this.saveMetadata();
    }

    private getPreviousStateInfo(targetSnapshotIndex: number, filePath: string): { source: 'snapshot', snapshotId: string } | { source: 'head' } {
        // Search backwards from the snapshot just before the target snapshot.
        for (let i = targetSnapshotIndex - 1; i >= 0; i--) {
            const snapshot = this.snapshots[i];
            const fileChange = snapshot.changedFiles.find(f => f.path === filePath);
            if (fileChange) {
                // We found the most recent mention of the file before our target snapshot.
                // We return this snapshot's ID. The content provider will either find the snapshot file
                // (for A or M) or find nothing (for D), which correctly represents the state.
                return { source: 'snapshot', snapshotId: snapshot.id };
            }
        }
        // If we didn't find it in any previous snapshot, its previous state is whatever is at HEAD.
        return { source: 'head' };
    }

    async getDiffUris(targetSnapshot: Snapshot, filePath: string): Promise<{ left: vscode.Uri, right: vscode.Uri } | null> {
        const targetSnapshotIndex = this.snapshots.findIndex(l => l.id === targetSnapshot.id);
        if (targetSnapshotIndex === -1) return null;

        // Check if there are any subsequent snapshots that also modify this file.
        const isLastChangeForThisFile = !this.snapshots
            .slice(targetSnapshotIndex + 1)
            .some(l => l.changedFiles.some(f => f.path === filePath));

        let rightUri: vscode.Uri;
        if (isLastChangeForThisFile) {
            // If this is the last time this file was changed in any snapshot, compare against the live workspace file.
            rightUri = vscode.Uri.file(path.join(this.getWorkspaceRoot(), filePath));
        } else {
            // Otherwise, compare against the historical snapshot file for this snapshot.
            const rightSnapshotPath = path.join(this.getSnapshotsRootPath(), targetSnapshot.id, filePath);
            rightUri = vscode.Uri.file(rightSnapshotPath);
        }

        let leftUri: vscode.Uri;
        const previousState = this.getPreviousStateInfo(targetSnapshotIndex, filePath);

        if (previousState.source === 'snapshot') {
            const query = `snapshotId=${previousState.snapshotId}`;
            leftUri = vscode.Uri.parse(`workspace_snapshot-readonly:${filePath}?${query}`);
        } else { // source is 'head'
            const query = `head=true`;
            leftUri = vscode.Uri.parse(`workspace_snapshot-readonly:${filePath}?${query}`);
        }

        return { left: leftUri, right: rightUri };
    }

    private async getPreviousStateContent(filePath: string, stopBeforeSnapshotId: string): Promise<{ content: string | null, existed: boolean }> {
        const stopIndex = this.snapshots.findIndex(l => l.id === stopBeforeSnapshotId);
        // Search backwards from the snapshot just before the stopIndex
        for (let i = stopIndex - 1; i >= 0; i--) {
            const snapshot = this.snapshots[i];
            const change = snapshot.changedFiles.find(f => f.path === filePath);
            if (change) {
                if (change.status === 'D') {
                    return { content: null, existed: false };
                }
                const snapshotFilePath = path.join(this.getSnapshotsRootPath(), snapshot.id, filePath);
                if (fs.existsSync(snapshotFilePath)) {
                    return { content: fs.readFileSync(snapshotFilePath, 'utf-8'), existed: true };
                }
                return { content: null, existed: false };
            }
        }
    
        // If the file was never seen in any previous snapshot, its state is determined by HEAD.
        const existedAtHead = await this.git.fileExistsAtHead(filePath);
        if (existedAtHead) {
            const content = await this.git.getFileContentAtHead(filePath);
            return { content, existed: true };
        }
    
        return { content: null, existed: false };
    }

    async discardSnapshot(snapshotId: string): Promise<void> {
        const snapshotToDiscard = this.snapshots.find(l => l.id === snapshotId);
        if (!snapshotToDiscard) { return; }

        // Clear the list of changed files for this snapshot in the metadata.
        snapshotToDiscard.changedFiles.splice(0, snapshotToDiscard.changedFiles.length);

        // Delete the entire snapshot directory for this snapshot to remove all its history.
        const snapshotDir = path.join(this.getSnapshotsRootPath(), snapshotToDiscard.id);
        if (fs.existsSync(snapshotDir)) {
            fs.rmSync(snapshotDir, { recursive: true, force: true });
        }

        // Save the updated metadata and refresh the view.
        // The snapshot will now be empty and filtered out by the getChildren method.
        this.saveMetadata();
        this.refresh();
    }

    async discardAllSnapshots(): Promise<void> {
        // Get a unique list of all files affected by any snapshot.
        const allChangedFiles = Array.from(new Set(this.snapshots.flatMap(l => l.changedFiles.map(f => f.path))));

        if (allChangedFiles.length > 0) {
            // Use git's native checkout command to discard all changes.
            // This correctly handles line endings and other metadata, resulting in a clean git status.
            await this.git.checkoutFiles(allChangedFiles);
        }

        // Delete all snapshots and metadata
        const snapshotsRoot = this.getSnapshotsRootPath();
        if (fs.existsSync(snapshotsRoot)) {
            fs.rmSync(snapshotsRoot, { recursive: true, force: true });
        }

        this.snapshots = [];
        this.refresh();
    }

    async clearAllSnapshots(): Promise<void> {
        // Delete all snapshot files and metadata without touching working directory files
        const snapshotsRoot = this.getSnapshotsRootPath();
        if (fs.existsSync(snapshotsRoot)) {
            fs.rmSync(snapshotsRoot, { recursive: true, force: true });
        }

        this.snapshots = [];
        // No need to refresh here, as refresh is called immediately after in extension.ts
    }
}
