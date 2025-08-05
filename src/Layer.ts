import * as vscode from 'vscode';
import * as path from 'path';

export class Layer extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly id: string,
        public readonly timestamp: number,
        public readonly changedFiles: { path: string, status: 'A' | 'M' | 'D' }[],
    ) {
        super(label, vscode.TreeItemCollapsibleState.Collapsed);
        this.tooltip = `Layer: ${this.label}\nID: ${this.id}`;
        this.description = `${this.changedFiles.length} file(s)`;
        this.contextValue = 'layer';
        this.iconPath = new vscode.ThemeIcon('layers');
    }

    getFiles(): LayerFile[] {
        return this.changedFiles.map(file => new LayerFile(file.path, file.status, this));
    }

    getPreviousLayerName(): string {
       return `State before this layer`;
    }
}

export class LayerFile extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly status: 'A' | 'M' | 'D',
        public readonly layer: Layer
    ) {
        super(path.basename(label), vscode.TreeItemCollapsibleState.None);
        const dirname = path.dirname(label);
        // Only show the description if it's a real subdirectory, not '.'
        this.description = dirname === '.' ? '' : dirname;
        this.resourceUri = vscode.Uri.file(path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, label));
        this.command = {
            command: 'changelayers.showDiff',
            title: 'Show Layer Diff',
            arguments: [this.layer, this.label]
        };
        this.contextValue = 'layerFile';

        switch (status) {
            case 'A':
                this.iconPath = new vscode.ThemeIcon('diff-added');
                this.tooltip = `Added in layer: ${label}`;
                break;
            case 'M':
                this.iconPath = new vscode.ThemeIcon('diff-modified');
                this.tooltip = `Modified in layer: ${label}`;
                break;
            case 'D':
                this.iconPath = new vscode.ThemeIcon('diff-removed');
                this.tooltip = `Deleted in layer: ${label}`;
                break;
        }
    }
}
