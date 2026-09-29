import assert from "node:assert/strict";
import { test } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeBorrowedDependencies } from "./link-guard.ts";

function topology(check: (paths: { main: string; linked: string; local: string; plain: string; taken: string; reason: string | undefined }) => void) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "link-guard-")));
  try {
    const main = join(root, "main"), linked = join(root, "linked"), local = join(root, "local"), plain = join(root, "plain"), taken = join(root, "taken");
    const git = (...args: string[]) => execFileSync("git", ["-C", main, ...args], { stdio: "ignore" });
    mkdirSync(main);
    git("init", "-q");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init");
    git("worktree", "add", "-q", "--detach", linked);
    git("worktree", "add", "-q", "--detach", local);
    git("worktree", "add", "-q", "--detach", taken);
    rmSync(join(taken, ".git"));
    mkdirSync(join(main, "nested"));
    symlinkSync("../node_modules", join(main, "nested", "node_modules"));
    git("worktree", "add", "-q", "--detach", join(main, "nested\nsplit"));
    execFileSync("git", ["init", "-q", taken]);
    mkdirSync(join(main, "node_modules"));
    writeFileSync(join(main, "node_modules", "package.json"), "{}");
    symlinkSync(join(main, "node_modules"), join(linked, "node_modules"));
    symlinkSync(join(main, "node_modules"), join(taken, "node_modules"));
    mkdirSync(join(local, "vendor"));
    symlinkSync("vendor", join(local, "node_modules"));
    mkdirSync(plain);
    const reason = removeBorrowedDependencies(local);
    check({ main, linked, local, plain, taken, reason });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("removes borrowed dependencies and preserves their target", () => topology(({ reason, linked, main }) => {
  assert.equal(reason, `Removed node_modules links to another checkout: ${join(linked, "node_modules")}. Install dependencies in each worktree instead (for example \`npm ci\`).`);
  assert.equal(existsSync(join(linked, "node_modules")), false, "the borrowed link is removed from any worktree of the repository");
  assert.ok(existsSync(join(main, "node_modules", "package.json")), "the link target is untouched");
}));
test("keeps links inside their own worktree", () => topology(({ local }) => {
  assert.ok(lstatSync(join(local, "node_modules")).isSymbolicLink(), "a link inside its own worktree stays");
}));
test("leaves a stale worktree path owned by another repository alone", () => topology(({ taken }) => {
  assert.ok(lstatSync(join(taken, "node_modules")).isSymbolicLink(), "a stale worktree path now owned by another repository is left alone");
}));
test("does not split a newline-containing worktree path", () => topology(({ main }) => {
  assert.ok(lstatSync(join(main, "nested", "node_modules")).isSymbolicLink(), "a newline-split worktree path cannot name a subdirectory");
}));
test("keeps installed node_modules directories", () => topology(({ main }) => {
  assert.ok(lstatSync(join(main, "node_modules")).isDirectory(), "an installed directory stays");
}));
test("returns no removal after the borrowed link is removed", () => topology(({ main }) => {
  assert.equal(removeBorrowedDependencies(main), undefined, "nothing left to remove");
}));
test("does nothing outside a git repository", () => topology(({ plain }) => {
  assert.equal(removeBorrowedDependencies(plain), undefined, "outside git, nothing is checked");
}));
