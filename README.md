# arc2zen (Node)

Node.js port of [olegfour3/arc2zen](https://github.com/olegfour3/arc2zen): export Arc / Zen bookmarks to HTML, or migrate Arc's pinned tabs, folders and favorites straight into Zen Browser. macOS only, Node 20+, no dependencies (LZ4 is implemented in pure JS).

## Run

No clone needed:

```bash
npx github:estruyf/arc2zen-node
```

From a local checkout:

```bash
node bin/arc2zen.js        # or: npm start, or `npm link` and then `arc2zen`
```

```
  1. Export Arc bookmarks to HTML file
  2. Export Zen bookmarks to HTML file
  3. Migrate Arc bookmarks to Zen Browser
  4. Restore Zen from backup
  5. Delete all backups
```

Options:

- `--profile <dir>`: Zen profile directory. By default it's detected via `installs.ini` / `profiles.ini`, preferring a profile that has `zen-sessions.jsonlz4`.
- `--arc-file <path>`: Arc `StorableSidebar.json`. Default is `./StorableSidebar.json`, then `~/Library/Application Support/Arc/StorableSidebar.json`.
- `-v`: debug logging.

## Migration notes

- **Quit Zen (Cmd+Q) first.** The tool checks and waits.
- Each Arc space maps to the Zen workspace with the same name (case-insensitive). For unmatched spaces you can create the workspace in Zen, map it to an existing one, or skip it.
- **All existing pinned tabs, essentials and folders in Zen are replaced.** Before writing, `zen-sessions.jsonlz4` and `recovery.jsonlz4` are backed up as `*.backup_YYYYMMDD_HHMMSS`, and option 4 restores them. The naming matches the Python tool, so its backups also show up.
- Only pinned Arc tabs are migrated. Arc favorites become a `Favorites` folder at the top of every space from the same Arc profile.
- Passwords aren't migrated. Export them from the macOS Passwords app (File → Export All Passwords) and import the CSV in Zen at `about:logins` → ⋯ → Import from a File. Delete the CSV afterwards.

## Differences from the Python version

- Zen profile detection follows Firefox's `installs.ini` → `profiles.ini` order. The Python version took the first folder with "default" in its name, which can be an empty profile.
- The "is Zen running" check matches the actual `zen` process. The Python `pgrep -v` call didn't reliably do that.
- In the Zen HTML export, essentials not tied to any workspace go into a top-level `Essentials` folder instead of being dropped.
- Arc bookmarks without a URL are skipped instead of becoming broken tabs. Space names are trimmed consistently, and a missing `recovery.jsonlz4` no longer crashes the import.

## License

MIT. Original work © 2026 Oleg Pashuk, see [LICENSE](LICENSE).
