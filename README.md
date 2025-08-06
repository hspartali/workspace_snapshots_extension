# 📸 Workspace Snapshots

**Checkpoint and diff uncommitted changes, safely outside your Git history.**

![Workspace Snapshots Demo](https://raw.githubusercontent.com/hspartali/workspace_snapshots_extension/main/demo.gif)

Ever wanted to save multiple "versions" of your work before you're ready to commit? Workspace Snapshots lets you create sequential checkpoints of your code, making it easy to track, review, and roll back changes.

It's perfect for exploratory coding, complex refactors, or just organizing your thought process.

---

### ✨ Features

-   📸 **Instant Snapshots**: One-click checkpoint of all your current file changes, automatically named with the current date and time.
-   🔍 **Incremental Diffs**: Instantly see what changed between each snapshot.
-   ✍️ **Rename & Organize**: Right-click any snapshot to give it a more descriptive name.
-   💡 **Visual Indicators**: The newest and last-restored snapshots are always highlighted with unique icons and labels, so you never lose your place.
-   ⏪ **Full Rollback**: Revert your entire workspace to the state of any previous snapshot with a single command.
-   🗑️ **Safe Deletion**: Remove individual snapshots from the view without altering the underlying history.
-   🧹 **Clean History**: Safely delete all snapshot history without affecting your current workspace files.

---

### 🚀 How to Use

1.  **Open the View**: Find the **Workspace Snapshots** icon in the Activity Bar.
2.  **Write Code**: Create, edit, or delete files.
3.  **Take a Snapshot**: Click the **`+`** icon to instantly create a new snapshot.
4.  **Review Diffs**: Expand a snapshot to see changed files (`A`dded, `M`odified, `D`eleted). Click any file to view its diff against the previous snapshot.
5.  **Manage History**: Right-click a snapshot to **Restore** your workspace, **Rename** it for clarity, or **Delete** it from the list.

---

**Note**: All snapshot data is stored in a private "shadow" Git repository, located in your global VS Code extension storage directory. This extension **never** touches your project's own Git history.