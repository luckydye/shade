#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createWriteStream, mkdirSync } from "node:fs";
import { pipeline } from "node:pipeline";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

if (!GITHUB_TOKEN) {
  console.log("GITHUB_TOKEN not set, skipping shade-web download");
  process.exit(0);
}

const targetDir = "public/app";
mkdirSync(targetDir, { recursive: true });

const releaseRes = await fetch(
  "https://api.github.com/repos/tihav/shade/releases/latest",
  {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
    },
  },
);

if (!releaseRes.ok) {
  throw new Error(`GitHub API returned ${releaseRes.status}`);
}

const release = await releaseRes.json();
const asset = release.assets.find((a) => a.name === "shade-web.tar.gz");

if (!asset) {
  throw new Error("Could not find shade-web.tar.gz asset");
}

const assetRes = await fetch(
  `https://api.github.com/repos/tihav/shade/releases/assets/${asset.id}`,
  {
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: "application/octet-stream",
    },
  },
);

if (!assetRes.ok) {
  throw new Error(`Asset download returned ${assetRes.status}`);
}

const tar = spawn("tar", ["-xz", "--strip-components=1", "-C", targetDir], {
  stdio: ["pipe", "inherit", "inherit"],
});

await pipeline(assetRes.body, tar.stdin);
