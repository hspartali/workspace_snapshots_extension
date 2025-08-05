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

        // The resourceUri needs to be the full path to the file for VS Code to find the correct file icon.
        // We also add the layerId and file path to the query so our new DecorationProvider can add the U/M/D status.
        const fullPath = path.join(vscode.workspace.workspaceFolders![0].uri.fsPath, label);
        this.resourceUri = vscode.Uri.file(fullPath).with({ query: `layerId=${layer.id}&path=${label}` });

        this.command = {
            command: 'changelayers.showDiff',
            title: 'Show Layer Diff',
            arguments: [this.layer, this.label]
        };

        // We set a more specific context value for deleted files to control which commands are shown.
        this.contextValue = status === 'D' ? 'layerFile-deleted' : 'layerFile';

        // We no longer set iconPath, so VS Code will use the file-type icon from the user's theme.
        // The status (A, M, D) will be handled by the LayerFileDecorationProvider.
        this.tooltip = `${status === 'A' ? 'Added' : status === 'M' ? 'Modified' : 'Deleted'} in layer: ${label}`;
    }
}
