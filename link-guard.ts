import { fileURLToPath } from "node:url";

export const dependencyLinkReason = "Refused: this links another checkout's node_modules. Install dependencies in this worktree instead (for example `npm ci`).";
export const dependencyLinkScript = fileURLToPath(new URL("./link-guard.sh", import.meta.url));

const prefix = /^(!|\{|then|do|else|elif|if|while|until)$|^[A-Za-z_][A-Za-z0-9_]*=/;

function linksNodeModules(words: string[]): boolean {
  let i = 0;
  while (i < words.length && prefix.test(words[i]!)) i++;
  if (words[i] !== "ln" && !words[i]?.endsWith("/ln")) return false;
  let end = false, symbolic = false, targetDirectory = false;
  const operands: string[] = [];
  for (i++; i < words.length; i++) {
    const word = words[i]!;
    if (/^[0-9]*[<>]/.test(word)) { if (/^[0-9]*[<>]+$/.test(word)) i++; }
    else if (!end && word === "--") end = true;
    else if (!end && /^--./.test(word)) {
      if (word === "--symbolic") symbolic = true;
      else if (word === "--target-directory" || word.startsWith("--target-directory=")) {
        targetDirectory = true;
        if (word === "--target-directory") i++;
      } else if (word === "--suffix") i++;
    } else if (!end && /^-./.test(word)) {
      for (let j = 1; j < word.length; j++) {
        if (word[j] === "s") symbolic = true;
        else if (word[j] === "t" || word[j] === "S") {
          if (word[j] === "t") targetDirectory = true;
          if (j === word.length - 1) i++;
          break;
        }
      }
    } else operands.push(word);
  }
  const first = operands[0]?.replace(/\/+$/, "").split("/").pop();
  const last = operands.at(-1);
  return symbolic && first === "node_modules" && (targetDirectory || operands.length === 1 || last === "." || last?.endsWith("/") || last?.replace(/\/+$/, "").split("/").pop() === "node_modules");
}

function simpleCommands(text: string): string[][] {
  const segments: string[][] = [];
  const pending: { delimiter: string; stripTabs: boolean }[] = [];
  let words: string[] = [], word = "", started = false, unquoted = true, hereString = false, quote: "'" | '"' | undefined;
  let waitingStripTabs: boolean | undefined;
  const flush = () => {
    if (started && waitingStripTabs !== undefined) {
      pending.push({ delimiter: word, stripTabs: waitingStripTabs });
      waitingStripTabs = undefined;
    } else if (started && hereString) hereString = false;
    else if (word) words.push(word);
    word = "";
    started = false;
    unquoted = true;
  };
  const segment = () => { flush(); if (words.length) segments.push(words); words = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (quote === "'") { if (c === "'") quote = undefined; else word += c; }
    else if (quote === '"') {
      if (c === '"') quote = undefined;
      else if (c === "\\" && i + 1 < text.length && "$`\"\\\n".includes(text[i + 1]!)) word += text[++i];
      else word += c;
    }
    else if (c === "'" || c === '"') { quote = c; started = true; unquoted = false; }
    else if (c === "<" && text[i + 1] === "<") {
      if (started && unquoted && /^[0-9]+$/.test(word)) { word = ""; started = false; }
      else flush();
      if (text[i + 2] === "<") { hereString = true; i += 2; }
      else { waitingStripTabs = text[i + 2] === "-"; i += waitingStripTabs ? 2 : 1; }
    }
    else if (c === "\\") { const next = text[++i] ?? ""; if (next !== "\n") { word += next; started = true; unquoted = false; } }
    else if (c === "#" && !started) { while (i + 1 < text.length && text[i + 1] !== "\n") i++; }
    else if (c === " " || c === "\t") flush();
    else if (c === "\n") {
      segment();
      if (waitingStripTabs !== undefined) return segments;
      for (const { delimiter, stripTabs } of pending) {
        let closed = false;
        while (i + 1 < text.length) {
          const start = i + 1;
          const end = text.indexOf("\n", start);
          const line = text.slice(start, end < 0 ? text.length : end);
          i = end < 0 ? text.length : end;
          if ((stripTabs ? line.replace(/^\t+/, "") : line) === delimiter) { closed = true; break; }
        }
        if (!closed) return segments;
      }
      pending.length = 0;
    }
    else if (";&|()`".includes(c)) { segment(); if (waitingStripTabs !== undefined) return segments; }
    else { word += c; started = true; }
  }
  segment();
  return segments;
}

export function dependencyLinkRefusal(command: string): string | undefined {
  return simpleCommands(command).some(linksNodeModules) ? dependencyLinkReason : undefined;
}
