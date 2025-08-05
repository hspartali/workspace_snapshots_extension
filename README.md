# Workspace Snapshots VS Code Extension

This extension provides a way to manage sequential sets of uncommitted changes in "Snapshots". You can create snapshots of your current changes and view the difference between each snapshot.

## Features

*   **Snapshot Changes**: Create a "Snapshot" from your current file changes.
*   **Snapshot Diffs**: View the changes introduced in one snapshot relative to the previous one.
*   **Discard Snapshots**: Easily discard a set of changes.

## How to Use

1.  Open the "Workspace Snapshots" view from the Activity Bar.
2.  Make some changes to your files.
3.  Click the `+` icon in the "Snapshots" view title bar to create a new snapshot.
4.  As you create more snapshots, you can click on the files within each snapshot to see the diff between it and the state after the previous snapshot was applied.

## Commands

*   `Workspace Snapshots: Create New Snapshot`: Creates a snapshot from all current changes.
*   `Workspace Snapshots: Discard Snapshot`: Removes a selected snapshot.
*   `Workspace Snapshots: Discard All Snapshots`: Removes all snapshots and reverts files.
*   `Workspace Snapshots: Refresh`: Refreshes the snapshot view.

This is a proof-of-concept extension.
