#!/usr/bin/env node
// Arc Bookmarks Tool: export Arc/Zen bookmarks to HTML or migrate Arc to Zen.

import { parseArgs } from "node:util";
import { ArcDataError, exportArcToHtml } from "../src/arc.js";
import { deleteAllBackups, formatStamp, listBackupFiles, listBackupStamps, restoreBackup } from "../src/backups.js";
import { exportZenToHtml } from "../src/zen-export.js";
import { importToZen } from "../src/zen-import.js";
import { findZenProfile, setProfileOverride, waitForZenClosed } from "../src/zen-profile.js";
import { ask, closePrompt, Colors, InputClosedError, rule, setVerbose } from "../src/ui.js";

const HELP = `Usage: arc2zen [options]

Interactive tool to export Arc/Zen bookmarks to HTML and migrate Arc to Zen.

Options:
  --profile <dir>    Zen profile directory (default: auto-detected)
  --arc-file <path>  Arc StorableSidebar.json (default: ./StorableSidebar.json,
                     then ~/Library/Application Support/Arc/StorableSidebar.json)
  -v, --verbose      Debug logging
  -h, --help         Show this help
`;

const { values: opts } = parseArgs({
  options: {
    profile: { type: "string" },
    "arc-file": { type: "string" },
    verbose: { type: "boolean", short: "v" },
    help: { type: "boolean", short: "h" },
  },
});

const EXIT = Symbol("exit");

function header(title) {
  console.log();
  console.log("-".repeat(60));
  console.log(title);
  console.log("-".repeat(60));
}

function printMenu() {
  console.log();
  console.log("Choose an option:");
  console.log();
  console.log(`  ${Colors.CYAN}1${Colors.RESET}. Export Arc bookmarks to HTML file`);
  console.log(`  ${Colors.CYAN}2${Colors.RESET}. Export Zen bookmarks to HTML file`);
  console.log(`  ${Colors.CYAN}3${Colors.RESET}. Migrate Arc bookmarks to Zen Browser`);
  console.log();
  console.log(`  ${Colors.YELLOW}4${Colors.RESET}. Restore Zen from backup`);
  console.log(`  ${Colors.YELLOW}5${Colors.RESET}. Delete all backups`);
  console.log();
  console.log(`  ${Colors.GREY}0${Colors.RESET}. Exit`);
  console.log();
}

function printExportResult([bookmarks, folders]) {
  console.log();
  console.log(`${Colors.GREEN}Export completed!${Colors.RESET}`);
  console.log(`  Bookmarks: ${bookmarks}`);
  console.log(`  Folders: ${folders}`);
}

async function exportOptions(splitLabel) {
  const output = (await ask("\nOutput filename (Enter for auto): ")) || undefined;
  const split = ["y", "yes"].includes((await ask(`Split by ${splitLabel} into separate files? (y/N): `)).toLowerCase());
  return { output, splitBySpace: split };
}

async function exportArc() {
  header("Export to HTML");
  const options = await exportOptions("spaces");
  try {
    printExportResult(exportArcToHtml({ ...options, arcFile: opts["arc-file"] }));
    return EXIT;
  } catch (e) {
    const label = e instanceof ArcDataError ? "Error:" : "Unexpected error:";
    console.log(`\n${Colors.RED}${label}${Colors.RESET} ${e.message}`);
  }
}

async function exportZen() {
  header("Export Zen to HTML");
  const options = await exportOptions("workspaces");
  try {
    printExportResult(exportZenToHtml(options));
    return EXIT;
  } catch (e) {
    console.log(`\n${Colors.RED}Error:${Colors.RESET} ${e.message}`);
  }
}

async function migrate() {
  header("Migrate to Zen Browser");
  await waitForZenClosed();
  try {
    if (await importToZen({ arcFile: opts["arc-file"] })) {
      console.log(`\n${Colors.GREEN}Migration completed successfully!${Colors.RESET}`);
      console.log("\nExiting...");
      return EXIT;
    }
  } catch (e) {
    if (e instanceof InputClosedError) throw e;
    console.log(`\n${Colors.RED}Unexpected error:${Colors.RESET} ${e.message}`);
  }
}

async function restoreMenu() {
  header("Restore from Backup");
  const profile = findZenProfile();
  const stamps = listBackupStamps(profile);
  if (!stamps.length) {
    console.log(`\n${Colors.YELLOW}No backups found.${Colors.RESET}`);
    return;
  }

  console.log(`\nAvailable backups (${stamps.length}):`);
  stamps.forEach((ts, i) => {
    const marker = i === 0 ? `${Colors.GREEN}(latest)${Colors.RESET}` : "";
    console.log(`  ${Colors.CYAN}${i + 1}${Colors.RESET}. ${formatStamp(ts)} ${marker}`);
  });

  console.log();
  const choice = await ask("Select backup number (Enter for latest): ");
  let stamp = stamps[0];
  if (choice) {
    const idx = Number.parseInt(choice, 10) - 1;
    if (!(idx >= 0 && idx < stamps.length)) {
      console.log(`${Colors.RED}Invalid number.${Colors.RESET}`);
      return;
    }
    stamp = stamps[idx];
  }

  await waitForZenClosed();
  console.log(`\nRestoring from backup ${stamp}...`);
  if (restoreBackup(stamp, profile)) {
    console.log(`\n${Colors.GREEN}Restore completed!${Colors.RESET}`);
    console.log("You can now open Zen Browser.");
    return EXIT;
  }
  console.log(`\n${Colors.RED}Restore failed.${Colors.RESET}`);
}

async function deleteBackupsMenu() {
  header("Delete All Backups");
  const profile = findZenProfile();
  const stamps = listBackupStamps(profile);
  if (!stamps.length) {
    console.log(`\n${Colors.YELLOW}No backups found.${Colors.RESET}`);
    return;
  }

  console.log(`\nFound ${listBackupFiles(profile).length} backup files (${stamps.length} timestamps):`);
  for (const ts of stamps) console.log(`  - ${formatStamp(ts)}`);
  console.log();
  if ((await ask(`${Colors.YELLOW}Delete all backups? (yes/no):${Colors.RESET} `)).toLowerCase() !== "yes") {
    console.log("Cancelled.");
    return;
  }
  console.log(`\n${Colors.GREEN}Deleted ${deleteAllBackups(profile)} backup files.${Colors.RESET}`);
}

const ACTIONS = { 1: exportArc, 2: exportZen, 3: migrate, 4: restoreMenu, 5: deleteBackupsMenu };

async function main() {
  if (opts.help) {
    console.log(HELP);
    return;
  }
  if (process.platform !== "darwin") {
    console.log(`\n${Colors.RED}Error: This tool only works on macOS.${Colors.RESET}`);
    console.log(`Current platform: ${process.platform}`);
    process.exitCode = 1;
    return;
  }
  setVerbose(Boolean(opts.verbose));
  setProfileOverride(opts.profile);

  console.log();
  rule();
  console.log(`${Colors.BOLD}Arc Bookmarks Tool${Colors.RESET}`);
  rule();

  for (;;) {
    printMenu();
    const choice = (await ask("Select option: ")).toLowerCase();
    if (choice === "0" || choice === "q") {
      console.log("\nBye!");
      return;
    }
    const action = ACTIONS[choice];
    if (!action) {
      console.log(`\n${Colors.RED}Invalid option.${Colors.RESET}`);
      continue;
    }
    if ((await action()) === EXIT) return;
  }
}

try {
  await main();
} catch (e) {
  if (!(e instanceof InputClosedError)) throw e;
  console.log("\n\nBye!");
} finally {
  closePrompt();
}
