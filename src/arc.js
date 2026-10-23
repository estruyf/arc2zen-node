// Read Arc Browser's StorableSidebar.json into a bookmark tree.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { bookmark, countBookmarks, folder, outputPath, toBookmarksHtml } from "./bookmarks.js";
import { log } from "./ui.js";

export class ArcDataError extends Error {}

const FILENAME = "StorableSidebar.json";

export const arcDataPath = () => path.join(os.homedir(), "Library", "Application Support", "Arc", FILENAME);

// Lookup order: explicit path, ./StorableSidebar.json, Arc's data directory.
export function readArcData(arcFile) {
  log.info("Reading Arc browser data...");
  const candidates = arcFile ? [arcFile] : [path.resolve(FILENAME), arcDataPath()];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      log.debug(`Using ${candidate}`);
      return JSON.parse(readFileSync(candidate, "utf8"));
    }
  }
  throw new ArcDataError(
    arcFile
      ? `File not found: ${arcFile}`
      : `File not found. Look for "${FILENAME}" in the Arc browser data directory: ${path.dirname(arcDataPath())}`,
  );
}

// Profile dicts look like {"default": true} or {"custom": {"_0": {"directoryBasename": "Profile 1"}}}.
function profileKey(profile) {
  if (!profile || typeof profile !== "object") return "default";
  if ("default" in profile) return "default";
  if (profile.custom && typeof profile.custom === "object") {
    for (const value of Object.values(profile.custom)) {
      if (value && typeof value === "object" && "directoryBasename" in value) return value.directoryBasename;
    }
  }
  return "default";
}

const isDict = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export class ArcDataParser {
  constructor(data, { includeUnpinned = false } = {}) {
    this.data = data;
    this.includeUnpinned = includeUnpinned;
    this.items = new Map();
  }

  // Returns one folder per Arc space (wrapped per profile container if Arc has several).
  parse() {
    log.info("Parsing Arc browser data...");
    const containers = this.data?.sidebar?.containers;
    if (!Array.isArray(containers)) throw new ArcDataError("Unexpected Arc data: sidebar.containers missing");

    const withData = containers.filter((c) => isDict(c) && "spaces" in c && "items" in c);
    const result = [];

    containers.forEach((container, index) => {
      if (!withData.includes(container)) return;
      log.debug(`Processing container ${index}...`);

      this.items = new Map(container.items.filter(isDict).map((item) => [item.id, item]));
      const spaces = this.parseSpaces(container.spaces);
      const favorites = this.parseFavorites(container);
      const spaceFolders = this.spacesToFolders(spaces, favorites);

      if (withData.length > 1) {
        if (spaceFolders.length) {
          const name = "global" in container ? "Main Profile" : `Profile ${index + 1}`;
          result.push(folder(name, spaceFolders));
        }
      } else {
        result.push(...spaceFolders);
      }
    });

    if (!result.length) log.warn("No bookmark data found in any container");
    return result;
  }

  // Favorites (top apps) per profile: [profileDict, containerId, profileDict, containerId, ...]
  parseFavorites(container) {
    const topIds = container.topAppsContainerIDs ?? [];
    const result = new Map();
    topIds.forEach((entry, i) => {
      if (!isDict(entry) || i + 1 >= topIds.length) return;
      const key = profileKey(entry);
      const children = this.buildTree(String(topIds[i + 1]));
      if (children.length) {
        log.debug(`Favorites [${key}]: ${countBookmarks(children)} bookmarks`);
        result.set(key, folder("Favorites", children));
      }
    });
    return result;
  }

  // newContainerIDs is [{"pinned": {}}, id, {"unpinned": {}}, id]
  parseSpaces(spacesData) {
    const spaces = [];
    let unnamed = 1;
    for (const space of spacesData) {
      if (!isDict(space) || !("newContainerIDs" in space)) continue;
      const name = space.title ?? `Space ${unnamed++}`;
      const key = profileKey(space.profile);
      const ids = space.newContainerIDs;
      ids.forEach((marker, i) => {
        if (isDict(marker) && i + 1 < ids.length) {
          spaces.push({ name, containerId: String(ids[i + 1]), isPinned: "pinned" in marker, profileKey: key });
        }
      });
    }
    log.debug(`Found ${spaces.length} space containers`);
    return spaces;
  }

  spacesToFolders(spaces, favorites) {
    const result = [];
    for (const space of spaces) {
      if (!this.includeUnpinned && !space.isPinned) continue;
      const children = this.buildTree(space.containerId);
      const fav = favorites.get(space.profileKey);
      if (fav) children.unshift(folder(fav.title, [...fav.children]));
      if (children.length) {
        result.push(folder(space.isPinned ? space.name : `${space.name} (Unpinned)`, children));
        log.debug(`Space '${space.name}': ${countBookmarks(children)} bookmarks`);
      }
    }
    return result;
  }

  // Builds the ordered tree under parentId; `seen` guards against cyclic data.
  buildTree(parentId, seen = new Set()) {
    if (seen.has(parentId)) return [];
    seen.add(parentId);

    const parent = this.items.get(parentId);
    const ids = Array.isArray(parent?.childrenIds)
      ? parent.childrenIds
      : [...this.items.values()].filter((item) => item.parentID === parentId).map((item) => item.id);

    const children = [];
    for (const id of ids) {
      const item = this.items.get(id);
      if (!item) continue;
      const tab = item.data?.tab;
      if (tab) {
        children.push(bookmark(item.title || tab.savedTitle || "Untitled", tab.savedURL || ""));
      } else if ("title" in item) {
        children.push(folder(item.title, this.buildTree(id, seen)));
      }
    }
    return children;
  }
}

export function getArcSpaces(arcFile) {
  return new ArcDataParser(readArcData(arcFile)).parse();
}

// Returns [bookmarks, top-level folders].
export function exportArcToHtml({ output, splitBySpace = false, includeUnpinned = false, arcFile } = {}) {
  const folders = new ArcDataParser(readArcData(arcFile), { includeUnpinned }).parse();

  if (splitBySpace && folders.length > 1) {
    let bookmarks = 0;
    for (const f of folders) {
      const file = outputPath(output, "arc_bookmarks", f.title);
      writeFileSync(file, toBookmarksHtml([f]), "utf8");
      const count = countBookmarks(f.children);
      bookmarks += count;
      console.log(`  ${path.basename(file)}: ${count} bookmarks`);
    }
    return [bookmarks, folders.length];
  }

  const file = outputPath(output, "arc_bookmarks");
  writeFileSync(file, toBookmarksHtml(folders), "utf8");
  log.info(`Export completed: ${file}`);
  return [folders.reduce((n, f) => n + countBookmarks(f.children), 0), folders.length];
}
