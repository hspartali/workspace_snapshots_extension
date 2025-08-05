# 📸 Workspace Snapshots

**Checkpoint and diff uncommitted changes, safely outside your Git history.**

Ever wanted to save multiple "versions" of your work before you're ready to commit? Workspace Snapshots lets you create sequential checkpoints of your code, making it easy to track, review, and roll back changes.

It's perfect for exploratory coding, complex refactors, or just organizing your thought process.

---

### ✨ Features

-   📸 **Create Snapshots**: One-click checkpoint of all your current file changes.
-   🔍 **Incremental Diffs**: Instantly see what changed in each specific step.
-   ✍️ **Rename & Organize**: Give your snapshots meaningful names like "Initial refactor".
-   ⏪ **Granular Rollback**: Revert a single file or an entire snapshot's history.
-   💥 **Full Reset**: Discard all snapshots and revert all files back to `HEAD`.
-   🧹 **Clean Up**: Clear all snapshot history while keeping your current code changes.

---

### 🚀 How to Use

1.  **Open the View**: Find the **Workspace Snapshots** icon in the Activity Bar.
2.  **Write Code**: Create, edit, or delete files.
3.  **Take a Snapshot**: Click the **`+`** icon in the view header.
4.  **Review Diffs**: Expand a snapshot to see changed files (`U`n-tracked, `M`odified, `D`eleted). Click any file to view its diff.
5.  **Iterate**: Keep coding and taking snapshots to build a step-by-step history of your work!

---

**Note**: All snapshot data is stored locally in your project's `.vscode/workspace_snapshots` folder. This extension **never** touches your Git commit history.