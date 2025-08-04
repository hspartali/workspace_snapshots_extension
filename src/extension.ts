import * as vscode from 'vscode';
import { LayerProvider } from './LayerProvider';
import { Layer } from './Layer';
import { Git } from './Git';
import * as fs from 'fs';
import * as path from 'path';

export function activate(context: vscode.ExtensionContext) {

    console.log('Congratulations, your extension "changelayers" is now active!');

    const git = new Git();
    const layerProvider = new LayerProvider(context.globalState, git);

    vscode.window.registerTreeDataProvider('changeLayersView', layerProvider);

    context.subscriptions.push(vscode.commands.registerCommand('changelayers.refresh', () => {
        layerProvider.refresh();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('changelayers.snapshot', async () => {
        const layerName = await vscode.window.showInputBox({ prompt: 'Enter a name for the new layer' });
        if (layerName) {
            try {
                await layerProvider.createLayer(layerName);
                vscode.window.showInformationMessage(`Layer "${layerName}" created.`);
                layerProvider.refresh();
            } catch (error: any) {
                vscode.window.showErrorMessage(`Failed to create layer: ${error.message}`);
            }
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('changelayers.showDiff', async (layer: Layer, filePath: string) => {
        try {
            const uris = await layerProvider.getDiffUris(layer, filePath);
            if (uris) {
                const { left, right } = uris;
                const title = `${path.basename(filePath)} (${layer.getPreviousLayerName()} vs ${layer.label})`;
                await vscode.commands.executeCommand('vscode.diff', left, right, title);
                // Clean up temp files
                setTimeout(() => {
                    fs.unlinkSync(left.fsPath);
                    fs.unlinkSync(right.fsPath);
                }, 5000); 
            }
        } catch (error: any) {
            vscode.window.showErrorMessage(`Could not show diff: ${error.message}`);
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
            `Are you sure you want to discard ALL layers? This is not reversible.`,
            { modal: true },
            'Discard All'
        );
        if (confirm === 'Discard All') {
            await layerProvider.discardAllLayers();
            layerProvider.refresh();
            vscode.window.showInformationMessage('All layers have been discarded.');
        }
    }));
}

export function deactivate() {}
