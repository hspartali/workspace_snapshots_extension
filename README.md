# Change Layers VS Code Extension

This extension provides a way to manage sequential sets of uncommitted changes in "Layers". You can create snapshots of your staged changes and view the difference between each layer.

## Features

*   **Snapshot Staged Changes**: Create a "Layer" from your currently staged changes.
*   **Layered Diffs**: View the changes introduced in one layer relative to the previous one.
*   **Discard Layers**: Easily discard a set of changes.

## How to Use

1.  Open the "Change Layers" view from the Activity Bar.
2.  Stage some changes using the regular Git Source Control view.
3.  Click the `+` icon in the "Layers" view title bar to create a new layer snapshot.
4.  As you create more layers, you can click on the files within each layer to see the diff between it and the state after the previous layer was applied.

## Commands

*   `Change Layers: Snapshot Staged Changes as New Layer`: Creates a layer from staged changes.
*   `Change Layers: Discard Layer`: Removes a selected layer.
*   `Change Layers: Discard All Layers`: Removes all layers.
*   `Change Layers: Refresh`: Refreshes the layer view.

This is a proof-of-concept extension.
