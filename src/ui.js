// Terminal colors, logging and line-based prompting.

import readline from "node:readline";

export const Colors = {
  RESET: "\x1b[0m",
  BOLD: "\x1b[1m",
  GREY: "\x1b[90m",
  RED: "\x1b[31m",
  GREEN: "\x1b[32m",
  YELLOW: "\x1b[33m",
  CYAN: "\x1b[36m",
  MAGENTA: "\x1b[35m",
};

const LEVELS = {
  debug: `${Colors.BOLD}${Colors.CYAN}DEBG${Colors.RESET}`,
  info: `${Colors.BOLD}${Colors.GREEN}INFO${Colors.RESET}`,
  warn: `${Colors.BOLD}${Colors.YELLOW}WARN${Colors.RESET}`,
  error: `${Colors.BOLD}${Colors.RED}ERRR${Colors.RESET}`,
};

let verbose = false;

export function setVerbose(value) {
  verbose = value;
}

function logLine(level, message) {
  if (level === "debug" && !verbose) return;
  const now = new Date();
  const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  console.error(`${Colors.GREY}${time}${Colors.RESET} ${LEVELS[level]} ${message}`);
}

export const log = {
  debug: (m) => logLine("debug", m),
  info: (m) => logLine("info", m),
  warn: (m) => logLine("warn", m),
  error: (m) => logLine("error", m),
};

export class InputClosedError extends Error {}

let rl;
let lines;

// Reads answers through the line iterator rather than rl.question(), so piped
// input that arrives before a prompt is printed isn't dropped.
export async function ask(question) {
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
    rl.on("SIGINT", () => {
      console.log("\n\nBye!");
      process.exit(0);
    });
    lines = rl[Symbol.asyncIterator]();
  }
  process.stdout.write(question);
  const { value, done } = await lines.next();
  if (done) throw new InputClosedError("Input closed");
  return value.trim();
}

export function closePrompt() {
  rl?.close();
}

export function rule(char = "=") {
  console.log(char.repeat(60));
}
