# 📸 Workspace Snapshots

**Checkpoint and diff uncommitted changes, safely outside your Git history.**

![Workspace Snapshots Demo](https://raw.githubusercontent.com/hspartali/workspace_snapshots_extension/main/demo.gif)

Ever wanted to save multiple "versions" of your work before you're ready to commit? Workspace Snapshots lets you create sequential checkpoints of your code, making it easy to track, review, and roll back changes.

It's perfect for exploratory coding, complex refactors, or just organizing your thought process.

---

### ✨ Features

-   📸 **Create Snapshots**: One-click checkpoint of all your current file changes.
-   🔍 **Incremental Diffs**: Instantly see what changed in each specific step.
-   ⏪ **Granular Rollback**: Revert all files in your workspace to a previous snapshot.
-   💥 **Full Reset**: Discard all uncommitted changes, reverting all files back to the state of the last snapshot.
-   🧹 **Clean Up**: Clear all snapshot history while keeping your current code changes.

---

### 🚀 How to Use

1.  **Open the View**: Find the **Workspace Snapshots** icon in the Activity Bar.
2.  **Write Code**: Create, edit, or delete files.
3.  **Take a Snapshot**: Click the **`+`** icon in the view header and provide a descriptive name.
4.  **Review Diffs**: Expand a snapshot to see changed files (`A`dded, `M`odified, `D`eleted). Click any file to view its diff.
5.  **Iterate**: Keep coding and taking snapshots to build a step-by-step history of your work!

---

**Note**: All snapshot data is stored in a private "shadow" Git repository, located in your global VS Code extension storage directory. This extension **never** touches your project's own Git history.
