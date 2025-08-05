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

    public getLayerById(id: string): Layer | undefined {
        return this.layers.find(l => l.id === id);
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

            // Also remove the snapshot file to keep storage clean
            const snapshotFilePath = path.join(this.getSnapshotsRootPath(), layer.id, file.label);
            if (fs.existsSync(snapshotFilePath)) {
                fs.unlinkSync(snapshotFilePath);
            }

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

    private getPreviousStateInfo(targetLayerIndex: number, filePath: string): { source: 'layer', layerId: string } | { source: 'head' } {
        // Search backwards from the layer just before the target layer.
        for (let i = targetLayerIndex - 1; i >= 0; i--) {
            const layer = this.layers[i];
            const fileChange = layer.changedFiles.find(f => f.path === filePath);
            if (fileChange) {
                // We found the most recent mention of the file before our target layer.
                // We return this layer's ID. The content provider will either find the snapshot
                // (for A or M) or find nothing (for D), which correctly represents the state.
                return { source: 'layer', layerId: layer.id };
            }
        }
        // If we didn't find it in any previous layer, its previous state is whatever is at HEAD.
        return { source: 'head' };
    }

    async getDiffUris(targetLayer: Layer, filePath: string): Promise<{ left: vscode.Uri, right: vscode.Uri } | null> {
        const targetLayerIndex = this.layers.findIndex(l => l.id === targetLayer.id);
        if (targetLayerIndex === -1) return null;

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

        let leftUri: vscode.Uri;
        const previousState = this.getPreviousStateInfo(targetLayerIndex, filePath);

        if (previousState.source === 'layer') {
            const query = `layerId=${previousState.layerId}`;
            leftUri = vscode.Uri.parse(`changelayer-readonly:${filePath}?${query}`);
        } else { // source is 'head'
            const query = `head=true`;
            leftUri = vscode.Uri.parse(`changelayer-readonly:${filePath}?${query}`);
        }

        return { left: leftUri, right: rightUri };
    }

    public async discardFileChange(file: LayerFile): Promise<void> {
        const targetLayerIndex = this.layers.findIndex(l => l.id === file.layer.id);
        if (targetLayerIndex === -1) { return; }
        const filePath = file.label;
    
        // 1. Find subsequent layers that also modify the file.
        const affectedSubsequentLayers = this.layers
            .slice(targetLayerIndex + 1)
            .filter(l => l.changedFiles.some(f => f.path === filePath));
    
        // 2. Confirm with the user if subsequent changes will also be discarded.
        if (affectedSubsequentLayers.length > 0) {
            const affectedLayerLabels = affectedSubsequentLayers.map(l => `"${l.label}"`).join(', ');
            const confirm = await vscode.window.showWarningMessage(
                `Discarding this change will also discard changes to "${filePath}" in subsequent layers: ${affectedLayerLabels}. This cannot be undone.`,
                { modal: true },
                'Discard Changes'
            );
            if (confirm !== 'Discard Changes') { return; }
        }
        // The initial confirmation is handled by the command itself.
    
        // 3. Revert the workspace file to its state *before* the target layer.
        const { content: previousContent, existed: fileExistedBefore } = await this.getPreviousStateContent(filePath, file.layer.id);
        const workspaceFilePath = path.join(this.getWorkspaceRoot(), filePath);
    
        if (fileExistedBefore) {
            // Use git checkout if reverting to HEAD state to handle line endings correctly.
            const previousStateInfo = this.getPreviousStateInfo(targetLayerIndex, filePath);
            if (previousStateInfo.source === 'head') {
                 await this.git.checkoutFiles([filePath]);
            } else {
                 fs.writeFileSync(workspaceFilePath, previousContent!);
            }
        } else {
            // File did not exist before, so reverting means deleting it.
            if (fs.existsSync(workspaceFilePath)) {
                fs.unlinkSync(workspaceFilePath);
            }
        }
    
        // 4. Update metadata and clean snapshots for all affected layers.
        const allAffectedLayers = [file.layer, ...affectedSubsequentLayers];
        for (const layer of allAffectedLayers) {
            const fileIndex = layer.changedFiles.findIndex(f => f.path === filePath);
            if (fileIndex > -1) {
                layer.changedFiles.splice(fileIndex, 1);
                const snapshotFilePath = path.join(this.getSnapshotsRootPath(), layer.id, filePath);
                if (fs.existsSync(snapshotFilePath)) {
                    fs.unlinkSync(snapshotFilePath);
                }
            }
        }
    
        // 5. Save and refresh.
        this.saveMetadata();
        this.refresh();
        vscode.window.showInformationMessage(`Discarded changes to "${filePath}".`);
    }

    private async getPreviousStateContent(filePath: string, stopBeforeLayerId: string): Promise<{ content: string | null, existed: boolean }> {
        const stopIndex = this.layers.findIndex(l => l.id === stopBeforeLayerId);
        // Search backwards from the layer just before the stopIndex
        for (let i = stopIndex - 1; i >= 0; i--) {
            const layer = this.layers[i];
            const change = layer.changedFiles.find(f => f.path === filePath);
            if (change) {
                if (change.status === 'D') {
                    return { content: null, existed: false };
                }
                const snapshotPath = path.join(this.getSnapshotsRootPath(), layer.id, filePath);
                if (fs.existsSync(snapshotPath)) {
                    return { content: fs.readFileSync(snapshotPath, 'utf-8'), existed: true };
                }
                return { content: null, existed: false };
            }
        }
    
        // If the file was never seen in any previous layer, its state is determined by HEAD.
        const existedAtHead = await this.git.fileExistsAtHead(filePath);
        if (existedAtHead) {
            const content = await this.git.getFileContentAtHead(filePath);
            return { content, existed: true };
        }
    
        return { content: null, existed: false };
    }

    async discardLayer(layerId: string): Promise<void> {
        const layerToDiscard = this.layers.find(l => l.id === layerId);
        if (!layerToDiscard) { return; }

        // Clear the list of changed files for this layer in the metadata.
        layerToDiscard.changedFiles.splice(0, layerToDiscard.changedFiles.length);

        // Delete the entire snapshot directory for this layer to remove all its history.
        const snapshotDir = path.join(this.getSnapshotsRootPath(), layerToDiscard.id);
        if (fs.existsSync(snapshotDir)) {
            fs.rmSync(snapshotDir, { recursive: true, force: true });
        }

        // Save the updated metadata and refresh the view.
        // The layer will now be empty and filtered out by the getChildren method.
        this.saveMetadata();
        this.refresh();
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

    async clearAllLayers(): Promise<void> {
        // Delete all snapshots and metadata without touching working directory files
        const layersRoot = this.getLayersRootPath();
        if (fs.existsSync(layersRoot)) {
            fs.rmSync(layersRoot, { recursive: true, force: true });
        }

        this.layers = [];
        // No need to refresh here, as refresh is called immediately after in extension.ts
    }
}