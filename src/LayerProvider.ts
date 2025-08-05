import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Layer, LayerFile } from './Layer';
import { Git } from './Git';

interface LayerData {
    id: string;
    label: string;
    timestamp: number;
    changedFiles: { path: string, status: 'A' | 'M' | 'D' }[];
}

export class LayerProvider implements vscode.TreeDataProvider<Layer | LayerFile> {
    private _onDidChangeTreeData: vscode.EventEmitter<Layer | undefined | null | void> = new vscode.EventEmitter<Layer | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<Layer | undefined | null | void> = this._onDidChangeTreeData.event;

    private layers: Layer[] = [];

    constructor(private context: vscode.ExtensionContext, private git: Git) {
        this.loadLayersFromMetadata();
    }

    refresh(): void {
        this.loadLayersFromMetadata();
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: Layer | LayerFile): vscode.TreeItem {
        return element;
    }

    getChildren(element?: Layer): vscode.ProviderResult<Layer[] | LayerFile[]> {
        if (element) {
            return element.getFiles();
        } else {
            return this.layers.filter(layer => layer.changedFiles.length > 0);
        }
    }

    // --- Storage and Metadata ---

    private getWorkspaceRoot(): string {
        if (!vscode.workspace.workspaceFolders || vscode.workspace.workspaceFolders.length === 0) {
            throw new Error('No workspace folder open.');
        }
        return vscode.workspace.workspaceFolders[0].uri.fsPath;
    }

    private getLayersRootPath(): string {
        return path.join(this.getWorkspaceRoot(), '.vscode', 'changelayers');
    }

    private getSnapshotsRootPath(): string {
        return path.join(this.getLayersRootPath(), 'snapshots');
    }

    private getMetadataPath(): string {
        return path.join(this.getLayersRootPath(), 'metadata.json');
    }

    private loadLayersFromMetadata() {
        try {
            if (!fs.existsSync(this.getMetadataPath())) {
                this.layers = [];
                return;
            }
            const metadataContent = fs.readFileSync(this.getMetadataPath(), 'utf-8');
            const layersData: any[] = JSON.parse(metadataContent);
            this.layers = layersData.map(data => {
                const changedFiles = data.changedFiles.map((file: any) => {
                    if (typeof file === 'string') {
                        // Backwards compatibility for old metadata format
                        return { path: file, status: 'M' };
                    }
                    return file;
                });
                return new Layer(data.label, data.id, data.timestamp, changedFiles);
            });
            this.layers.sort((a, b) => a.timestamp - b.timestamp);
        } catch (error) {
            console.error("Failed to load layers metadata", error);
            this.layers = [];
        }
    }

    private saveMetadata() {
        const layersData = this.layers.map(layer => ({
            id: layer.id,
            label: layer.label,
            timestamp: layer.timestamp,
            changedFiles: layer.changedFiles
        }));
        if (!fs.existsSync(this.getLayersRootPath())) {
            fs.mkdirSync(this.getLayersRootPath(), { recursive: true });
        }
        fs.writeFileSync(this.getMetadataPath(), JSON.stringify(layersData, null, 2));
    }

    public removeFileFromLayer(file: LayerFile) {
        const layer = this.layers.find(l => l.id === file.layer.id);
        if (!layer) {
            return;
        }
        const fileIndex = layer.changedFiles.findIndex(f => f.path === file.label);
        if (fileIndex > -1) {
            layer.changedFiles.splice(fileIndex, 1);
            this.saveMetadata();
        }
    }

    // --- Core Functionality ---

    private async getPreviousState(filePath: string): Promise<{ content: string | null, existed: boolean }> {
        // Search backwards from the last layer to find the most recent state of the file
        for (let i = this.layers.length - 1; i >= 0; i--) {
            const layer = this.layers[i];
            const change = layer.changedFiles.find(f => f.path === filePath);
            if (change) {
                // We found the last time this file was changed in a layer
                if (change.status === 'D') {
                    // It was deleted, so it didn't exist before the current changes.
                    return { content: null, existed: false };
                }
                // It was Added or Modified, so its content is in this layer's snapshot.
                const snapshotPath = path.join(this.getSnapshotsRootPath(), layer.id, filePath);
                if (fs.existsSync(snapshotPath)) {
                    return { content: fs.readFileSync(snapshotPath, 'utf-8'), existed: true };
                }
                // This case (A/M change without a snapshot) would indicate a problem,
                // but we'll treat it as if the file didn't exist.
                return { content: null, existed: false };
            }
        }

        // If the file was never seen in any layer, its state is determined by HEAD.
        const existedAtHead = await this.git.fileExistsAtHead(filePath);
        if (existedAtHead) {
            const content = await this.git.getFileContentAtHead(filePath);
            return { content, existed: true };
        }

        // If not in layers and not in HEAD, it didn't exist.
        return { content: null, existed: false };
    }

    async createLayer(label: string): Promise<void> {
        await this.git.checkIsRepo();
        // Get a reliable list of all files that are new, modified, or deleted.
        const potentiallyChangedFiles = await this.git.getPotentiallyChangedFiles();
        const filesToSnapshot: { path: string, status: 'A' | 'M' | 'D' }[] = [];

        if (potentiallyChangedFiles.length === 0) {
            throw new Error('No changes detected to create a layer from.');
        }

        const newLayerId = Date.now().toString();
        const newLayerSnapshotPath = path.join(this.getSnapshotsRootPath(), newLayerId);
        fs.mkdirSync(newLayerSnapshotPath, { recursive: true });

        for (const file of potentiallyChangedFiles) {
            const workspaceFilePath = path.join(this.getWorkspaceRoot(), file);
            const fileCurrentlyExists = fs.existsSync(workspaceFilePath);
            const currentContent = fileCurrentlyExists ? fs.readFileSync(workspaceFilePath, 'utf-8') : null;

            const { content: previousContent, existed: fileExistedBefore } = await this.getPreviousState(file);

            if (fileCurrentlyExists) {
                if (!fileExistedBefore) {
                    // State change: Non-existent -> Existent. This is an ADDITION.
                    filesToSnapshot.push({ path: file, status: 'A' });
                    const destPath = path.join(newLayerSnapshotPath, file);
                    fs.mkdirSync(path.dirname(destPath), { recursive: true });
                    fs.writeFileSync(destPath, currentContent!);
                } else if (currentContent !== previousContent) {
                    // State change: Existent -> Existent (but different content). This is a MODIFICATION.
                    filesToSnapshot.push({ path: file, status: 'M' });
                    const destPath = path.join(newLayerSnapshotPath, file);
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
            throw new Error('No effective changes detected since the last layer or HEAD.');
        }

        const newLayer = new Layer(label, newLayerId, parseInt(newLayerId, 10), filesToSnapshot);
        this.layers.push(newLayer);
        this.saveMetadata();
    }

    async getDiffUris(targetLayer: Layer, filePath: string): Promise<{ left: vscode.Uri, right: vscode.Uri } | null> {
        const targetLayerIndex = this.layers.findIndex(l => l.id === targetLayer.id);
        if (targetLayerIndex === -1) return null;

        const previousLayer = targetLayerIndex > 0 ? this.layers[targetLayerIndex - 1] : null;
        const isLastLayer = targetLayerIndex === this.layers.length - 1;

        let rightUri: vscode.Uri;
        if (isLastLayer) {
            // For the most recent layer, compare against the live file in the workspace. This makes it editable.
            rightUri = vscode.Uri.file(path.join(this.getWorkspaceRoot(), filePath));
        } else {
            // For historical layers, use the static snapshot.
            const rightSnapshotPath = path.join(this.getSnapshotsRootPath(), targetLayer.id, filePath);
            rightUri = vscode.Uri.file(rightSnapshotPath);
        }

        // The logic for the "left" side now uses a virtual document to ensure it's read-only.
        let leftUri: vscode.Uri;
        if (previousLayer) {
            // The URI contains the file path and the layer ID in the query
            const query = `layerId=${previousLayer.id}`;
            leftUri = vscode.Uri.parse(`changelayer-readonly:${filePath}?${query}`);
        } else {
            // For the first layer, the URI indicates we should get the content from HEAD
            const query = `head=true`;
            leftUri = vscode.Uri.parse(`changelayer-readonly:${filePath}?${query}`);
        }

        return { left: leftUri, right: rightUri };
    }

    async revertFile(file: LayerFile) {
        const targetLayerIndex = this.layers.findIndex(l => l.id === file.layer.id);
        const previousLayer = targetLayerIndex > 0 ? this.layers[targetLayerIndex - 1] : null;
        const workspaceFilePath = path.join(this.getWorkspaceRoot(), file.label);

        if (previousLayer) {
            const previousSnapshotPath = path.join(this.getSnapshotsRootPath(), previousLayer.id, file.label);
            if (fs.existsSync(previousSnapshotPath)) {
                const contentToRevertTo = fs.readFileSync(previousSnapshotPath, 'utf-8');
                fs.writeFileSync(workspaceFilePath, contentToRevertTo);
            } else {
                // File didn't exist in previous layer, so it was added in this one. Reverting means deleting.
                if (fs.existsSync(workspaceFilePath)) {
                    fs.unlinkSync(workspaceFilePath);
                }
            }
        } else {
            // Reverting the first layer means reverting to HEAD state.
            if (await this.git.fileExistsAtHead(file.label)) {
                // Use git checkout to properly revert the file to its HEAD state.
                await this.git.checkoutFiles([file.label]);
            } else {
                // File didn't exist at HEAD, so it was added in this layer. Reverting is deletion.
                if (fs.existsSync(workspaceFilePath)) {
                    fs.unlinkSync(workspaceFilePath);
                }
            }
        }
    }

    async discardLayer(layerId: string): Promise<void> {
        const layerIndex = this.layers.findIndex(l => l.id === layerId);
        if (layerIndex === -1) { return; }

        if (layerIndex < this.layers.length - 1) {
            throw new Error('For safety, only the most recent layer can be discarded.');
        }

        const layerToDiscard = this.layers[layerIndex];
        // Revert all files in the discarded layer in parallel for better performance.
        const revertPromises = layerToDiscard.changedFiles.map(fileChange =>
            this.revertFile(new LayerFile(fileChange.path, fileChange.status, layerToDiscard))
        );
        await Promise.all(revertPromises);

        // Delete snapshot directory
        const snapshotDir = path.join(this.getSnapshotsRootPath(), layerToDiscard.id);
        if (fs.existsSync(snapshotDir)) {
            fs.rmSync(snapshotDir, { recursive: true, force: true });
        }
        
        // Update metadata
        this.layers.pop();
        this.saveMetadata();
    }

    async discardAllLayers(): Promise<void> {
        // Get a unique list of all files affected by any layer.
        const allChangedFiles = Array.from(new Set(this.layers.flatMap(l => l.changedFiles.map(f => f.path))));

        if (allChangedFiles.length > 0) {
            // Use git's native checkout command to discard all changes.
            // This correctly handles line endings and other metadata, resulting in a clean git status.
            await this.git.checkoutFiles(allChangedFiles);
        }

        // Delete all snapshots and metadata
        const layersRoot = this.getLayersRootPath();
        if (fs.existsSync(layersRoot)) {
            fs.rmSync(layersRoot, { recursive: true, force: true });
        }

        this.layers = [];
        this.refresh();
    }
}