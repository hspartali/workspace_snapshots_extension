import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Layer, LayerFile } from './Layer';
import { Git } from './Git';

export class LayerProvider implements vscode.TreeDataProvider<Layer | LayerFile> {
    private _onDidChangeTreeData: vscode.EventEmitter<Layer | undefined | null | void> = new vscode.EventEmitter<Layer | undefined | null | void>();
    readonly onDidChangeTreeData: vscode.Event<Layer | undefined | null | void> = this._onDidChangeTreeData.event;

    private layers: Layer[] = [];

    constructor(private memento: vscode.Memento, private git: Git) {
        this.loadLayers();
    }

    refresh(): void {
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

    private getLayersDir(): string {
        const storagePath = this.memento.keys()[0] ? path.dirname(this.memento.get<string>(this.memento.keys()[0])!) : (this.memento as any)._globalState._storagePath;
        if (!storagePath) {
            throw new Error('Could not determine extension storage path.');
        }
        const layersDir = path.join(storagePath, 'layers');
        if (!fs.existsSync(layersDir)) {
            fs.mkdirSync(layersDir, { recursive: true });
        }
        return layersDir;
    }
    
    private loadLayers() {
        const layersData = this.memento.get<{ id: string; label: string; changedFiles: string[] }[]>('layers', []);
        this.layers = layersData.map(data => {
            const patchPath = path.join(this.getLayersDir(), `${data.id}.patch`);
            return new Layer(data.label, data.id, patchPath, data.changedFiles);
        });
        this.sortLayers();
    }

    private saveLayers() {
        const layersData = this.layers.map(layer => ({
            id: layer.id,
            label: layer.label,
            changedFiles: layer.changedFiles
        }));
        this.memento.update('layers', layersData);
    }
    
    private sortLayers() {
        this.layers.sort((a, b) => parseInt(a.id) - parseInt(b.id));
    }
    
    async createLayer(label: string): Promise<void> {
        await this.git.checkIsRepo();
        const changedFiles = await this.git.getStagedFiles();
        if (changedFiles.length === 0) {
            throw new Error('No staged changes to create a layer from.');
        }

        const id = Date.now().toString();
        const patchPath = path.join(this.getLayersDir(), `${id}.patch`);
        
        await this.git.createPatchFromIndex(patchPath);

        const newLayer = new Layer(label, id, patchPath, changedFiles);
        this.layers.push(newLayer);
        this.sortLayers();
        this.saveLayers();
    }

    async discardLayer(layerId: string): Promise<void> {
        const layerIndex = this.layers.findIndex(l => l.id === layerId);
        if (layerIndex > -1) {
            const layer = this.layers[layerIndex];
            if (fs.existsSync(layer.patchPath)) {
                fs.unlinkSync(layer.patchPath);
            }
            this.layers.splice(layerIndex, 1);
            this.saveLayers();
        }
    }

    async discardAllLayers(): Promise<void> {
        for (const layer of this.layers) {
            if (fs.existsSync(layer.patchPath)) {
                fs.unlinkSync(layer.patchPath);
            }
        }
        this.layers = [];
        this.saveLayers();
    }

    async getDiffUris(targetLayer: Layer, filePath: string): Promise<{ left: vscode.Uri, right: vscode.Uri } | null> {
        await this.git.checkIsRepo();
        
        const tempDir = path.join(this.getLayersDir(), 'temp', Date.now().toString());
        fs.mkdirSync(tempDir, { recursive: true });

        const targetLayerIndex = this.layers.findIndex(l => l.id === targetLayer.id);
        if (targetLayerIndex === -1) { return null; }

        try {
            // Stash any uncommitted changes to ensure a clean slate
            const stashed = await this.git.stash();

            // Create Left URI (State before target layer)
            const leftContent = await this.getFileContentAtLayer(targetLayerIndex - 1, filePath);
            const leftUri = vscode.Uri.file(path.join(tempDir, `left_${path.basename(filePath)}`));
            fs.writeFileSync(leftUri.fsPath, leftContent);

            // Create Right URI (State after target layer)
            const rightContent = await this.getFileContentAtLayer(targetLayerIndex, filePath);
            const rightUri = vscode.Uri.file(path.join(tempDir, `right_${path.basename(filePath)}`));
            fs.writeFileSync(rightUri.fsPath, rightContent);

            // Restore original state
            await this.git.resetHard();
            if (stashed) {
                await this.git.stashPop();
            }
            
            return { left: leftUri, right: rightUri };

        } catch (error) {
            // Ensure cleanup on error
            await this.git.resetHard();
            throw error;
        }
    }

    private async getFileContentAtLayer(layerIndex: number, filePath: string): Promise<string> {
        await this.git.resetHard(); // Go back to HEAD

        // Apply all patches up to and including the target layer
        for (let i = 0; i <= layerIndex; i++) {
            const currentLayer = this.layers[i];
            if (fs.existsSync(currentLayer.patchPath)) {
                await this.git.applyPatch(currentLayer.patchPath);
            }
        }
        
        const root = this.git.getRepoRoot();
        const absoluteFilePath = path.join(root, filePath);
        
        if (fs.existsSync(absoluteFilePath)) {
            return fs.readFileSync(absoluteFilePath, 'utf-8');
        }
        return ''; // File might not exist at this layer yet
    }
}
