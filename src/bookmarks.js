// Bookmark tree helpers and Netscape bookmark HTML export.
//
// A bookmark is { title, url }; a folder is { title, children: [...] }.

import path from "node:path";

export const bookmark = (title, url) => ({ title, url });
export const folder = (title, children = []) => ({ title, children });
export const isFolder = (item) => Array.isArray(item.children);

export function countBookmarks(items) {
  let count = 0;
  for (const item of items) {
    count += isFolder(item) ? countBookmarks(item.children) : 1;
  }
  return count;
}

// Returns [bookmarks, folders], counting every nested folder (including the top-level ones).
export function countItems(folders) {
  let bookmarks = 0;
  let folderCount = 0;
  for (const f of folders) {
    folderCount++;
    for (const item of f.children) {
      if (isFolder(item)) {
        const [b, fl] = countItems([item]);
        bookmarks += b;
        folderCount += fl;
      } else {
        bookmarks++;
      }
    }
  }
  return [bookmarks, folderCount];
}

function escapeHtml(text) {
  return (text ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function folderToHtml(f, level) {
  const indent = "\t".repeat(level);
  const lines = [`${indent}<DT><H3>${escapeHtml(f.title)}</H3>`, `${indent}<DL><p>`];
  for (const item of f.children) {
    if (isFolder(item)) {
      lines.push(...folderToHtml(item, level + 1));
    } else {
      lines.push(`${indent}\t<DT><A HREF="${escapeHtml(item.url)}">${escapeHtml(item.title)}</A>`);
    }
  }
  lines.push(`${indent}</DL><p>`);
  return lines;
}

export function toBookmarksHtml(folders) {
  const lines = [
    "<!DOCTYPE NETSCAPE-Bookmark-file-1>",
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    "<TITLE>Bookmarks</TITLE>",
    "<H1>Bookmarks</H1>",
    "<DL><p>",
  ];
  for (const f of folders) lines.push(...folderToHtml(f, 1));
  lines.push("</DL><p>");
  return lines.join("\n");
}

export function sanitizeFilename(name) {
  const cleaned = name.replace(/[\\/*?:"<>|]/g, "_").replace(/^[. ]+|[. ]+$/g, "");
  return cleaned || "unnamed";
}

export function dateStamp() {
  const d = new Date();
  return `${d.getFullYear()}_${String(d.getMonth() + 1).padStart(2, "0")}_${String(d.getDate()).padStart(2, "0")}`;
}

// Output path for an export; with `suffix` (split mode) it becomes <base>_<suffix><ext>.
export function outputPath(requested, prefix, suffix) {
  let base;
  let ext;
  if (requested) {
    const parsed = path.parse(requested);
    base = path.join(parsed.dir, parsed.name);
    ext = parsed.ext || ".html";
  } else {
    base = `${prefix}_${dateStamp()}`;
    ext = ".html";
  }
  return suffix ? `${base}_${sanitizeFilename(suffix)}${ext}` : `${base}${ext}`;
}
