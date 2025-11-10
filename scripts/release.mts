#!/usr/bin/env node

import { spawnSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";

interface PackageJson {
  version: string;
  name?: string;
}

interface GitHubRelease {
  id: number;
  html_url: string;
  upload_url: string;
}

function exec(command: string, args: string[] = []): string {
  const result = spawnSync(command, args, {
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  });

  if (result.error) {
    throw new Error(
      `Failed to execute: ${command} ${args.join(" ")}\n${result.error}`
    );
  }

  if (result.status !== 0) {
    throw new Error(
      `Command failed: ${command} ${args.join(" ")}\nstderr: ${result.stderr}`
    );
  }

  return result.stdout.trim();
}

function getPackageVersion(): string {
  const packageJsonPath = join(process.cwd(), "package.json");
  const packageJson: PackageJson = JSON.parse(
    readFileSync(packageJsonPath, "utf-8")
  );
  return packageJson.version;
}

function getCurrentBranch(): string {
  return exec("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
}

function tagExists(tag: string): boolean {
  try {
    // Validate tag format to prevent any issues
    if (!/^v?\d+\.\d+\.\d+(-[\w.]+)?(\+[\w.]+)?$/.test(tag)) {
      throw new Error("Invalid tag format");
    }
    exec("git", ["rev-parse", `refs/tags/${tag}`]);
    return true;
  } catch {
    return false;
  }
}

function createTag(tag: string): void {
  // Validate tag format
  if (!/^v?\d+\.\d+\.\d+(-[\w.]+)?(\+[\w.]+)?$/.test(tag)) {
    throw new Error("Invalid tag format");
  }

  console.log(`Creating tag: ${tag}`);
  exec("git", ["config", "user.name", "github-actions[bot]"]);
  exec("git", [
    "config",
    "user.email",
    "github-actions[bot]@users.noreply.github.com",
  ]);
  exec("git", ["tag", tag]);
  exec("git", ["push", "origin", tag]);
  console.log(`✓ Tag ${tag} created and pushed`);
}

function packPackage(): string {
  console.log("Packing package...");
  const output = exec("pnpm", ["pack"]);

  // pnpm pack outputs the filename of the created tarball
  const lines = output.split("\n");
  const tarballLine = lines.find((line) => line.endsWith(".tgz"));

  if (!tarballLine) {
    throw new Error("Failed to find tarball filename in pack output");
  }

  const tarballPath = tarballLine.trim();
  console.log(`✓ Package packed: ${tarballPath}`);

  return tarballPath;
}

async function createGitHubRelease(tag: string): Promise<GitHubRelease> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN environment variable is required");
  }

  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) {
    throw new Error("GITHUB_REPOSITORY environment variable is required");
  }

  console.log(`Creating GitHub release for ${tag}`);

  // Generate release notes
  const notes = generateReleaseNotes(tag);

  const releaseData = {
    tag_name: tag,
    name: `Release ${tag}`,
    body: notes,
    draft: false,
    prerelease: false,
  };

  const response = await fetch(
    `https://api.github.com/repos/${repo}/releases`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(releaseData),
    }
  );

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `Failed to create GitHub release: ${response.status} ${response.statusText}\n${errorBody}`
    );
  }

  const result = (await response.json()) as GitHubRelease;
  console.log(`✓ GitHub release created for ${tag}`);
  console.log(`  URL: ${result.html_url}`);

  return result;
}

async function uploadReleaseAsset(
  release: GitHubRelease,
  filePath: string
): Promise<void> {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error("GITHUB_TOKEN environment variable is required");
  }

  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) {
    throw new Error("GITHUB_REPOSITORY environment variable is required");
  }

  console.log(`Uploading asset: ${filePath}`);

  // Read the file
  const fileBuffer = readFileSync(filePath);
  const fileName = filePath.split("/").pop() || filePath;

  // GitHub's upload_url contains {?name,label} template which we need to replace
  const uploadUrl = `https://uploads.github.com/repos/${repo}/releases/${
    release.id
  }/assets?name=${encodeURIComponent(fileName)}`;

  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/gzip",
      "Content-Length": fileBuffer.length.toString(),
    },
    body: fileBuffer,
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `Failed to upload asset: ${response.status} ${response.statusText}\n${errorBody}`
    );
  }

  const result: any = await response.json();
  console.log(`✓ Asset uploaded successfully`);
  console.log(`  Download URL: ${result.browser_download_url}`);
}

function generateReleaseNotes(tag: string): string {
  try {
    // Get the previous tag
    const previousTag = exec("git", [
      "describe",
      "--tags",
      "--abbrev=0",
      "HEAD^",
    ]);

    // Validate tags to prevent any issues
    if (
      !/^v?\d+\.\d+\.\d+/.test(previousTag) ||
      !/^v?\d+\.\d+\.\d+/.test(tag)
    ) {
      throw new Error("Invalid tag format");
    }

    // Get commits between tags
    const commits = exec("git", [
      "log",
      `${previousTag}..HEAD`,
      "--pretty=format:- %s (%h)",
      "--no-merges",
    ]);

    const repo = process.env.GITHUB_REPOSITORY;
    return `## What's Changed\n\n${commits}\n\n**Full Changelog**: https://github.com/${repo}/compare/${previousTag}...${tag}`;
  } catch {
    // If no previous tag exists, just list recent commits
    const commits = exec("git", [
      "log",
      "--pretty=format:- %s (%h)",
      "--no-merges",
      "-n",
      "20",
    ]);
    return `## What's Changed\n\n${commits}`;
  }
}

async function main() {
  try {
    // Check if we're on main branch
    const currentBranch = getCurrentBranch();
    if (currentBranch !== "main") {
      console.log(
        `Not on main branch (current: ${currentBranch}), skipping release`
      );
      process.exit(0);
    }

    // Get version from package.json
    const version = getPackageVersion();
    const tag = `v${version}`;

    // Validate version format (supports semver with prerelease/build metadata)
    if (!/^\d+\.\d+\.\d+(-[\w.]+)?(\+[\w.]+)?$/.test(version)) {
      throw new Error("Invalid version format in package.json");
    }

    console.log(`Current version: ${version}`);
    console.log(`Tag to create: ${tag}`);

    // Check if tag already exists
    if (tagExists(tag)) {
      console.log(`Tag ${tag} already exists, skipping`);
      process.exit(0);
    }

    // Pack the package
    const tarballPath = packPackage();

    // Create tag
    createTag(tag);

    // Create GitHub release
    const release = await createGitHubRelease(tag);

    // Upload the tarball as a release asset
    await uploadReleaseAsset(release, tarballPath);

    console.log("✓ Release process completed successfully");
  } catch (error) {
    console.error("Error:", error);
    process.exit(1);
  }
}

main();
