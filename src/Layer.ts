import * as vscode from 'vscode';
import * as path from 'path';

export class Layer extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly id: string,
        public readonly patchPath: string,
        public readonly changedFiles: string[],
    ) {
        super(label, vscode.TreeItemCollapsibleState.Collapsed);
        this.tooltip = `Layer: ${this.label}\nID: ${this.id}`;
        this.description = `${this.changedFiles.length} file(s)`;
        this.contextValue = 'layer';
    }

    getFiles(): LayerFile[] {
        return this.changedFiles.map(file => new LayerFile(file, this));
    }

    getPreviousLayerName(): string {
        // This is a simplification. A more robust solution would query the provider.
        const prevId = parseInt(this.id, 10) - 1;
        return `Layer before ${this.label}`;
    }
}

export class LayerFile extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly layer: Layer
    ) {
        super(label, vscode.TreeItemCollapsibleState.None);
        this.resourceUri = vscode.Uri.file(path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, label));
        this.command = {
            command: 'changelayers.showDiff',
            title: 'Show Layer Diff',
            arguments: [this.layer, this.label]
        };
    }
}
