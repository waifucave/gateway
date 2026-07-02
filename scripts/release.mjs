#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { spawnSync } from "node:child_process";

const repo = "waifucave/gateway";
const packageName = "@waifucave/gateway";
const workflowFile = "npm-package.yml";
const npmCache = "/tmp/gateway-release-npm-cache";

const args = parseArgs(process.argv.slice(2));

main().catch((error) => {
  console.error(`\nrelease failed: ${error.message}`);
  process.exit(1);
});

async function main() {
  if (args.help) {
    printUsage();
    return;
  }

  const version = args.version;
  if (!version || !isSemver(version)) {
    printUsage();
    throw new Error("Pass a valid SemVer version, for example 0.1.2.");
  }

  const tag = `v${version}`;
  const root = process.cwd();
  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (pkg.name !== packageName) {
    throw new Error(`Run this from the gateway repo root; found package ${pkg.name}.`);
  }

  const branch = capture("git", ["branch", "--show-current"]).trim();
  if (branch !== "main") {
    throw new Error(`Release must run from main; current branch is ${branch || "(detached)"}.`);
  }

  const status = capture("git", ["status", "--short"]).trim();
  if (status) {
    console.log("Pending changes detected:");
    console.log(status);
    console.log("");
  }

  const head = capture("git", ["rev-parse", "HEAD"]).trim();
  const remoteMain = capture("git", ["ls-remote", "origin", "refs/heads/main"]).trim().split(/\s+/)[0] ?? "";
  if (remoteMain !== head) {
    throw new Error(`Local HEAD ${head} does not match origin/main ${remoteMain}. Fetch/rebase before releasing.`);
  }

  ensureNoRemoteTag(tag);
  ensurePackageVersionMissing(version);

  if (args.dryRun) {
    console.log(`Dry run passed. ${tag} can be released from ${head}.`);
    return;
  }

  bumpVersions(version);
  validateAndPack(version);

  await confirmOrExit(
    `Validation passed. Push main, tag ${tag}, and publish ${packageName}@${version} to npm?`,
    args.yes,
  );

  run("git", ["add", "package.json", "package-lock.json"]);
  const staged = captureAllowFail("git", ["diff", "--cached", "--stat"]).stdout.trim();
  if (!staged) {
    throw new Error("Nothing staged after version bump.");
  }
  console.log(staged);

  run("git", ["commit", "-m", `chore: release ${version}`]);
  const releaseSha = capture("git", ["rev-parse", "HEAD"]).trim();
  run("git", ["push", "origin", "main"]);
  const pushedSha = capture("git", ["ls-remote", "origin", "refs/heads/main"]).trim().split(/\s+/)[0] ?? "";
  if (pushedSha !== releaseSha) {
    throw new Error(`Push verification failed; origin/main is ${pushedSha}, expected ${releaseSha}.`);
  }

  run("git", ["tag", tag, releaseSha]);
  run("git", ["push", "origin", tag]);

  const workflowStartedAt = new Date();
  run("gh", [
    "workflow",
    "run",
    workflowFile,
    "--repo",
    repo,
    "--ref",
    "main",
    "-f",
    `release_tag=${tag}`,
  ]);
  const runId = waitForWorkflowRun(workflowFile, {
    headBranch: "main",
    event: "workflow_dispatch",
    createdAfter: workflowStartedAt,
  });
  run("gh", ["run", "watch", String(runId), "--repo", repo, "--exit-status"]);

  verifyRegistry(version);

  console.log(`\nPublished ${packageName}@${version} to npm: https://www.npmjs.com/package/${packageName}`);
  console.log(
    `${repo}'s CI publish-freshness guard will pass on the next push to main, since the ` +
      "published version now matches package.json with matching content.",
  );
}

function parseArgs(argv) {
  const parsed = {
    dryRun: false,
    help: false,
    version: undefined,
    yes: false,
  };

  for (const arg of argv) {
    if (arg === "--dry-run") {
      parsed.dryRun = true;
    } else if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--yes" || arg === "-y") {
      parsed.yes = true;
    } else if (!parsed.version) {
      parsed.version = arg;
    } else {
      throw new Error(`Unexpected argument: ${arg}`);
    }
  }

  return parsed;
}

function printUsage() {
  console.log(`Usage:
  node scripts/release.mjs <version> [--yes]
  node scripts/release.mjs <version> --dry-run

Examples:
  node scripts/release.mjs 0.1.2
  node scripts/release.mjs 0.1.2 --yes
  node scripts/release.mjs 0.1.2 --dry-run

This script bumps the version, validates (typecheck, test, build, npm pack
sanity check), commits, pushes main, tags, dispatches the "${workflowFile}"
workflow (which publishes to npm via NPM_TOKEN), watches it to completion,
and verifies the package is live on the npm registry.`);
}

function isSemver(version) {
  return /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version);
}

function bumpVersions(version) {
  run("npm", ["version", version, "--no-git-tag-version"]);
  // Keeps the lockfile's two version entries ("version" and
  // packages[""].version) in sync with package.json — a real past bug here.
  run("npm", ["install", "--package-lock-only", "--ignore-scripts"], { npmCache: true });
}

function validateAndPack(version) {
  run("npm", ["run", "typecheck"]);
  run("npm", ["test"]);
  run("npm", ["run", "build"]);

  const packOutput = capture("npm", ["pack", "--dry-run", "--json"], { npmCache: true });
  const [entry] = JSON.parse(packOutput);
  if (!entry || !Array.isArray(entry.files) || entry.files.length === 0) {
    throw new Error("npm pack --dry-run reported no files; refusing to release an empty package.");
  }
  const paths = new Set(entry.files.map((file) => file.path));
  if (!paths.has("LICENSE")) {
    throw new Error("npm pack --dry-run is missing LICENSE; check the \"files\" field in package.json.");
  }
  if (![...paths].some((path) => path.startsWith("data/"))) {
    throw new Error("npm pack --dry-run is missing data/; check the \"files\" field in package.json.");
  }
  if (!entry.name || entry.version !== version) {
    throw new Error(`npm pack --dry-run reports version ${entry.version}, expected ${version}.`);
  }
}

function verifyRegistry(version) {
  const deadline = Date.now() + 120_000;
  let lastInfo;
  while (Date.now() < deadline) {
    const info = JSON.parse(capture("npm", ["view", packageName, "version", "dist-tags", "--json"], { npmCache: true }));
    if (info.version === version && info["dist-tags"]?.latest === version) {
      return;
    }
    lastInfo = info;
    console.log(`${packageName} registry still stale: ${JSON.stringify(info)}. Retrying...`);
    sleep(5_000);
  }
  throw new Error(`${packageName} registry verification failed: ${JSON.stringify(lastInfo)}`);
}

function ensureNoRemoteTag(tag) {
  const tagInfo = capture("git", ["ls-remote", "origin", `refs/tags/${tag}`]).trim();
  if (tagInfo) {
    throw new Error(`Remote tag already exists: ${tag}`);
  }
}

function ensurePackageVersionMissing(version) {
  const result = run("npm", ["view", `${packageName}@${version}`, "version"], {
    allowFailure: true,
    capture: true,
    npmCache: true,
  });
  if (result.status === 0 && result.stdout.trim() === version) {
    throw new Error(`npm package already exists: ${packageName}@${version}`);
  }
  if (result.status !== 0) {
    const combined = `${result.stdout}\n${result.stderr}`;
    if (!/E404|404|No match found|not found/i.test(combined)) {
      throw new Error(`Could not verify npm package absence for ${packageName}@${version}: ${combined.trim()}`);
    }
  }
}

function waitForWorkflowRun(workflow, filters) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const runs = JSON.parse(capture("gh", [
      "run",
      "list",
      "--repo",
      repo,
      "--workflow",
      workflow,
      "--limit",
      "20",
      "--json",
      "databaseId,headBranch,event,status,conclusion,createdAt,displayTitle,url",
    ]));
    const match = runs.find((candidate) => {
      if (filters.headBranch && candidate.headBranch !== filters.headBranch) {
        return false;
      }
      if (filters.event && candidate.event !== filters.event) {
        return false;
      }
      if (filters.createdAfter && Date.parse(candidate.createdAt) < filters.createdAfter.getTime() - 5_000) {
        return false;
      }
      return ["queued", "in_progress", "waiting", "requested", "completed"].includes(candidate.status);
    });
    if (match) {
      console.log(`${workflow} run: ${match.url}`);
      return match.databaseId;
    }
    sleep(3_000);
  }
  throw new Error(`Timed out waiting for ${workflow} workflow run.`);
}

async function confirmOrExit(question, yes) {
  if (yes) {
    return;
  }
  if (!input.isTTY) {
    throw new Error("Refusing to publish without --yes in a non-interactive shell.");
  }
  const rl = createInterface({ input, output });
  const answer = await rl.question(`${question} Type "yes" to continue: `);
  rl.close();
  if (answer !== "yes") {
    throw new Error("Release cancelled.");
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    env: commandEnv(options),
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (!options.allowFailure && result.status !== 0) {
    const stderr = result.stderr?.trim();
    throw new Error(`${command} ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`);
  }
  return result;
}

function capture(command, args, options = {}) {
  const result = run(command, args, { ...options, capture: true });
  return result.stdout;
}

function captureAllowFail(command, args, options = {}) {
  return run(command, args, { ...options, allowFailure: true, capture: true });
}

function commandEnv(options) {
  return {
    ...process.env,
    ...(options.npmCache ? { NPM_CONFIG_CACHE: npmCache } : {}),
    ...(options.env ?? {}),
  };
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
