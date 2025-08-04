import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Layer, LayerFile } from './Layer';
import { Git } from './Git';

interface LayerData {
    id: string;
    label: string;
    timestamp: number;
    changedFiles: string[];
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
            return this.layers;
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
            const layersData: LayerData[] = JSON.parse(metadataContent);
            this.layers = layersData.map(data => new Layer(data.label, data.id, data.timestamp, data.changedFiles));
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

    // --- Core Functionality ---

    async createLayer(label: string): Promise<void> {
        await this.git.checkIsRepo();
        const changedFiles = await this.git.getChangedFiles(); // Get all changed files in workdir
        const filesToSnapshot: string[] = [];

        const lastLayer = this.layers[this.layers.length - 1];
        const newLayerId = Date.now().toString();
        const newLayerSnapshotPath = path.join(this.getSnapshotsRootPath(), newLayerId);
        fs.mkdirSync(newLayerSnapshotPath, { recursive: true });

        for (const file of changedFiles) {
            const currentFilePath = path.join(this.getWorkspaceRoot(), file);
            if (!fs.existsSync(currentFilePath)) continue; // Skip deleted files for now
            
            const currentContent = fs.readFileSync(currentFilePath, 'utf-8');
            let previousContent: string;

            if (!lastLayer) { // First layer, compare against HEAD
                previousContent = await this.git.getFileContentAtHead(file);
            } else { // Subsequent layer, compare against previous snapshot
                const prevSnapshotPath = path.join(this.getSnapshotsRootPath(), lastLayer.id, file);
                if (fs.existsSync(prevSnapshotPath)) {
                    previousContent = fs.readFileSync(prevSnapshotPath, 'utf-8');
                } else {
                    // File was not in the last layer, so compare to HEAD
                    previousContent = await this.git.getFileContentAtHead(file);
                }
            }

            if (currentContent !== previousContent) {
                filesToSnapshot.push(file);
                const destPath = path.join(newLayerSnapshotPath, file);
                fs.mkdirSync(path.dirname(destPath), { recursive: true });
                fs.writeFileSync(destPath, currentContent);
            }
        }

        if (filesToSnapshot.length === 0) {
            throw new Error('No changes detected since the last layer or HEAD.');
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
        
        let contentToRevertTo: string;
        if (previousLayer) {
            const previousSnapshotPath = path.join(this.getSnapshotsRootPath(), previousLayer.id, file.label);
            if (!fs.existsSync(previousSnapshotPath)) {
                // If the file didn't exist in the previous layer, it means it was created in the target layer.
                // Reverting means deleting it from the working directory.
                fs.unlinkSync(path.join(this.getWorkspaceRoot(), file.label));
                return;
            }
            contentToRevertTo = fs.readFileSync(previousSnapshotPath, 'utf-8');
        } else {
            // Reverting the first layer means reverting to HEAD
            contentToRevertTo = await this.git.getFileContentAtHead(file.label);
        }

        fs.writeFileSync(path.join(this.getWorkspaceRoot(), file.label), contentToRevertTo);
    }
    
    async discardLayer(layerId: string): Promise<void> {
        const layerIndex = this.layers.findIndex(l => l.id === layerId);
        if (layerIndex === -1) return;
        
        if(layerIndex < this.layers.length - 1) {
            throw new Error('For safety, only the most recent layer can be discarded.');
        }

        const layerToDiscard = this.layers[layerIndex];
        // Revert all files in the discarded layer
        for (const file of layerToDiscard.changedFiles) {
            await this.revertFile(new LayerFile(file, layerToDiscard));
        }

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
        const allChangedFiles = Array.from(new Set(this.layers.flatMap(l => l.changedFiles)));

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