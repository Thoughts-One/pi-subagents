/**
 * worktree.ts — Git worktree isolation for agents.
 *
 * Creates a temporary git worktree so the agent works on an isolated copy of the repo.
 * On completion, if no changes were made, the worktree is cleaned up.
 * If changes exist, a branch is created and returned in the result.
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

export interface WorktreeInfo {
  /** Absolute path to the worktree directory (the copied repo's root). */
  path: string;
  /** Branch name created for this worktree (if changes exist). */
  branch: string;
  /** Commit SHA that the worktree was created from. */
  baseSha: string;
  /**
   * Where the agent should work inside the worktree: the equivalent of the
   * cwd the worktree was created from. Equals `path` when that cwd was the
   * repo root; points at the copied subdirectory when it was deeper (e.g. a
   * monorepo package), so the requested scoping survives isolation.
   */
  workPath: string;
}

export type WorktreeCleanupResult =
  | {
    hasChanges: false;
    repository?: never;
    branch?: never;
    commit?: never;
    path?: never;
    error?: never;
  }
  | {
    hasChanges: true;
    /** Canonical repository that owns the preserved branch. */
    repository: string;
    /** Branch containing the preserved changes. */
    branch: string;
    /** Verified branch tip. */
    commit: string;
    path: string;
    error?: never;
  }
  | {
    hasChanges: true;
    repository?: never;
    branch?: never;
    commit?: never;
    /** Retained worktree path containing the unfinished changes. */
    path: string;
    /** Why inspection or preservation failed. */
    error: string;
  };

/**
 * Create a temporary git worktree for an agent.
 * Returns the worktree path, or undefined if not in a git repo.
 */
export function createWorktree(cwd: string, agentId: string): WorktreeInfo | undefined {
  // Verify we're in a git repo with at least one commit (HEAD must exist)
  let baseSha: string;
  let subdir: string;
  try {
    execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd, stdio: "pipe", timeout: 5000 });
    baseSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd, stdio: "pipe", timeout: 5000 })
      .toString()
      .trim();
    // Where cwd sits inside the repo ("" at the root): the agent must work at
    // the same subdirectory inside the copy, or a monorepo-package cwd would
    // silently widen to the whole repo. realpath both sides — git emits
    // resolved paths while cwd may arrive through a symlink (macOS /tmp).
    const topLevel = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, stdio: "pipe", timeout: 5000 })
      .toString()
      .trim();
    subdir = relative(realpathSync(topLevel), realpathSync(cwd));
  } catch {
    return undefined;
  }

  const branch = `pi-agent-${agentId}`;
  const suffix = randomUUID().slice(0, 8);
  const worktreePath = join(tmpdir(), `pi-agent-${agentId}-${suffix}`);

  try {
    // Create detached worktree at HEAD
    execFileSync("git", ["worktree", "add", "--detach", worktreePath, "HEAD"], {
      cwd,
      stdio: "pipe",
      timeout: 30000,
    });
    return { path: worktreePath, branch, baseSha, workPath: subdir ? join(worktreePath, subdir) : worktreePath };
  } catch {
    // If worktree creation fails, return undefined (agent runs in normal cwd)
    return undefined;
  }
}

/**
 * Clean up a worktree after agent completion.
 * - If no changes: remove worktree entirely.
 * - If changes exist: create a branch, commit changes, return branch info.
 */
export function cleanupWorktree(
  cwd: string,
  worktree: WorktreeInfo,
  agentDescription: string,
): WorktreeCleanupResult {
  if (!existsSync(worktree.path)) {
    return { hasChanges: false };
  }

  let operation = "verify worktree repository";
  try {
    const worktreeCommonDir = realpathSync(resolve(worktree.path, execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd: worktree.path,
      stdio: "pipe",
      timeout: 5000,
    }).toString().trim()));
    const repositoryCommonDir = realpathSync(resolve(cwd, execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd,
      stdio: "pipe",
      timeout: 5000,
    }).toString().trim()));
    if (worktreeCommonDir !== repositoryCommonDir) {
      return { hasChanges: true, path: worktree.path, error: `wrong_repository: worktree common dir ${worktreeCommonDir} differs from repository common dir ${repositoryCommonDir}` };
    }

    operation = "inspect worktree changes";
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: worktree.path,
      stdio: "pipe",
      timeout: 10000,
    }).toString().trim();

    if (status) {
      operation = "stage worktree changes";
      execFileSync("git", ["add", "-A"], { cwd: worktree.path, stdio: "pipe", timeout: 10000 });
      // Truncate description for commit message (no shell sanitization needed — execFileSync uses argv)
      const safeDesc = agentDescription.slice(0, 200);
      const commitMsg = `pi-agent: ${safeDesc}`;
      operation = "commit worktree changes";
      execFileSync("git", ["commit", "--no-verify", "-m", commitMsg], {
        cwd: worktree.path,
        stdio: "pipe",
        timeout: 10000,
      });
    } else {
      operation = "inspect worktree HEAD";
      const currentSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: worktree.path,
        stdio: "pipe",
        timeout: 5000,
      }).toString().trim();

      if (currentSha === worktree.baseSha) {
        // No changes — remove worktree only after repository identity verification.
        removeWorktree(cwd, worktree.path);
        return { hasChanges: false };
      }
    }

    // Create a branch pointing to the worktree's HEAD.
    // If the branch already exists, append a suffix to avoid overwriting previous work.
    let branchName = worktree.branch;
    operation = "create preservation branch";
    try {
      execFileSync("git", ["branch", branchName], {
        cwd: worktree.path,
        stdio: "pipe",
        timeout: 5000,
      });
    } catch {
      // Branch already exists — use a unique suffix
      branchName = `${worktree.branch}-${Date.now()}`;
      operation = "create unique preservation branch";
      execFileSync("git", ["branch", branchName], {
        cwd: worktree.path,
        stdio: "pipe",
        timeout: 5000,
      });
    }
    operation = "verify preservation branch";
    const commit = execFileSync("git", ["rev-parse", "--verify", "HEAD^{commit}"], {
      cwd: worktree.path,
      stdio: "pipe",
      timeout: 5000,
    }).toString().trim();
    const branchCommit = execFileSync("git", ["rev-parse", "--verify", `refs/heads/${branchName}^{commit}`], {
      cwd,
      stdio: "pipe",
      timeout: 5000,
    }).toString().trim();
    if (branchCommit !== commit) {
      return { hasChanges: true, path: worktree.path, error: `branch_mismatch: ${branchName} points to ${branchCommit}; worktree HEAD is ${commit}` };
    }
    const repository = realpathSync(execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      stdio: "pipe",
      timeout: 5000,
    }).toString().trim());

    // Remove the worktree only after the branch tip and repository identity match.
    removeWorktree(cwd, worktree.path);

    return {
      hasChanges: true,
      repository,
      branch: branchName,
      commit,
      path: worktree.path,
    };
  } catch (error) {
    const stderr = error !== null && typeof error === "object" && "stderr" in error
      ? error.stderr
      : undefined;
    const stderrText = typeof stderr === "string"
      ? stderr.trim()
      : Buffer.isBuffer(stderr)
        ? stderr.toString().trim()
        : "";
    const gitError = stderrText || (error instanceof Error ? error.message : String(error));
    return {
      hasChanges: true,
      path: worktree.path,
      error: `${operation} failed: ${gitError}`,
    };
  }
}

/**
 * Force-remove a worktree.
 */
function removeWorktree(cwd: string, worktreePath: string): void {
  try {
    execFileSync("git", ["worktree", "remove", "--force", worktreePath], {
      cwd,
      stdio: "pipe",
      timeout: 10000,
    });
  } catch {
    // If git worktree remove fails, try pruning
    try {
      execFileSync("git", ["worktree", "prune"], { cwd, stdio: "pipe", timeout: 5000 });
    } catch { /* ignore */ }
  }
}

/**
 * Prune any orphaned worktrees (crash recovery).
 */
export function pruneWorktrees(cwd: string): void {
  try {
    execFileSync("git", ["worktree", "prune"], { cwd, stdio: "pipe", timeout: 5000 });
  } catch { /* ignore */ }
}
