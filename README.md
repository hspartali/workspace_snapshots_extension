# 📸 Workspace Snapshots

**Checkpoint and diff uncommitted changes, safely outside your Git history.**

![Workspace Snapshots Demo](https://raw.githubusercontent.com/hspartali/workspace_snapshots_extension/refs/heads/main/demo.gif)

Ever wanted to save multiple "versions" of your work before you're ready to commit? Workspace Snapshots lets you create sequential checkpoints of your code, making it easy to track, review, and roll back changes. It's perfect for exploratory coding, complex refactors, or just organizing your thought process.

---

### How It Works

Workspace Snapshots creates a private **"shadow" Git repository** for your project, stored safely in VS Code's global extension directory. Every snapshot is a commit in this shadow repo. This means you get the power of Git for your uncommitted work **without ever touching your project's actual `.git` history**.

---

### ✨ Features

-   ✅ **Effortless Checkpoints**: Instantly save the state of all your project files with a single click. The extension automatically detects changes, so you can't accidentally create an empty snapshot.

-   🧠 **Smart Diffs**: Diffs are always relevant. When you delete a snapshot, subsequent diffs automatically re-calculate against the new previous state, keeping your history clean and understandable.

-   ⚙️ **Toggleable Diff Modes**: Instantly switch between two diff modes using the toggle icon in the title bar:
    -   `$(git-compare)` **Compare to Previous**: See what changed since the last snapshot.
    -   `$(files)` **Compare to Workspace**: See how a snapshot version differs from your current live file.

-   ⏪ **One-Click Restore**: Revert your entire workspace back to the state of any snapshot. Perfect for abandoning a failed experiment or returning to a known-good state.

-   🛠️ **Full History Management**:
    -   **Rename**: Give snapshots meaningful names (e.g., "Before Big Refactor") to organize your workflow.
    -   **Delete**: Safely remove snapshots you no longer need. The history intelligently heals around them.
    -   **Clear All**: Wipe the entire snapshot history for a workspace with a single command, without affecting your current files.

---

### ⚙️ Configuration

The diff mode can be toggled directly from the icon in the view's title bar. This modifies the following setting in your `settings.json`:

-   `workspaceSnapshots.diffAgainstWorkspace` (boolean, default: `false`): Controls the diffing behavior. `false` compares against the previous snapshot, `true` compares against the current workspace file.

---

**Note**: All snapshot data is stored in a private "shadow" Git repository. This extension **never** touches your project's own Git history.