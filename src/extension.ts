import * as vscode from 'vscode';
import { LayerProvider } from './LayerProvider';
import { Layer, LayerFile } from './Layer';
import { Git } from './Git';
import * as fs from 'fs';
import * as path from 'path';
import { ReadonlyContentProvider } from './ReadonlyContentProvider';
import { LayerFileDecorationProvider } from './LayerFileDecorationProvider';

export function activate(context: vscode.ExtensionContext) {

    console.log('Congratulations, your extension "changelayers" is now active!');

    const git = new Git();
    const layerProvider = new LayerProvider(context, git);
    const readonlyProvider = new ReadonlyContentProvider(git);
    const decorationProvider = new LayerFileDecorationProvider(layerProvider);

    context.subscriptions.push(vscode.workspace.registerTextDocumentContentProvider('changelayer-readonly', readonlyProvider));
    vscode.window.registerTreeDataProvider('changeLayersView', layerProvider);
    context.subscriptions.push(vscode.window.registerFileDecorationProvider(decorationProvider));

    // When the tree data changes, we trigger a decoration refresh.
    layerProvider.onDidChangeTreeData(() => {
        decorationProvider.refresh();
    });

    context.subscriptions.push(vscode.commands.registerCommand('changelayers.refresh', () => {
        layerProvider.refresh();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('changelayers.snapshot', async () => {
        // Generate a layer name from the current date and time.
        const layerName = new Date().toLocaleString();
        try {
            await layerProvider.createLayer(layerName);
            vscode.window.showInformationMessage(`Layer "${layerName}" created.`);
            layerProvider.refresh();
        } catch (error: any) {
            vscode.window.showErrorMessage(`Failed to create layer: ${error.message}`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('changelayers.showDiff', async (layer: Layer, filePath: string) => {
        try {
            const uris = await layerProvider.getDiffUris(layer, filePath);
            if (uris) {
                const { left, right } = uris;
                const title = `${path.basename(filePath)} (${layer.getPreviousLayerName()} vs ${layer.label})`;
                // The preserveFocus option keeps the focus on the tree view, making the selection highlight stay prominent.
                await vscode.commands.executeCommand('vscode.diff', left, right, title, { preserveFocus: true });
            }
        } catch (error: any) {
            vscode.window.showErrorMessage(`Could not show diff: ${error.message}`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('changelayers.discardFile', async (file: LayerFile) => {
        const confirm = await vscode.window.showWarningMessage(
            `Are you sure you want to revert "${file.label}" to its state before layer "${file.layer.label}"?`,
            { modal: true },
            'Revert'
        );
        if (confirm === 'Revert') {
            await layerProvider.revertFile(file);
            vscode.window.showInformationMessage(`Reverted "${file.label}".`);
            layerProvider.removeFileFromLayer(file);
            layerProvider.refresh();
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('changelayers.discard', async (layer: Layer) => {
        const confirm = await vscode.window.showWarningMessage(
            `Are you sure you want to discard the layer "${layer.label}"? This is not reversible.`,
            { modal: true },
            'Discard'
        );
        if (confirm === 'Discard') {
            await layerProvider.discardLayer(layer.id);
            layerProvider.refresh();
            vscode.window.showInformationMessage(`Layer "${layer.label}" discarded.`);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('changelayers.discardAll', async () => {
        const confirm = await vscode.window.showWarningMessage(
            `Are you sure you want to discard ALL layers? This is not reversible and will revert your files.`,
            { modal: true },
            'Discard All'
        );
        if (confirm === 'Discard All') {
            await layerProvider.discardAllLayers();
            layerProvider.refresh();
            vscode.window.showInformationMessage('All layers have been discarded and files reverted.');
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('changelayers.clearAllLayers', async () => {
        const confirm = await vscode.window.showWarningMessage(
            `Are you sure you want to clear ALL layers history? This will NOT revert your files, only remove the layer metadata and snapshots. This is not reversible.`,
            { modal: true },
            'Clear All'
        );
        if (confirm === 'Clear All') {
            await layerProvider.clearAllLayers();
            layerProvider.refresh();
            vscode.window.showInformationMessage('All layers history has been cleared.');
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('changelayers.openFile', async (file: LayerFile) => {
        const workspaceRoot = git.getRepoRoot();
        if (!workspaceRoot) {
            vscode.window.showErrorMessage("Could not find repository root.");
            return;
        }

        try {
            const fileUri = vscode.Uri.file(path.join(workspaceRoot, file.label));
            const doc = await vscode.workspace.openTextDocument(fileUri);
            await vscode.window.showTextDocument(doc, { preview: false });
        } catch (error: any) {
            vscode.window.showErrorMessage(`Could not open file '${file.label}': ${error.message}`);
        }
    }));
}

export function deactivate() {}
