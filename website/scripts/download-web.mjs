#!/usr/bin/env node
import { mkdirSync } from "node:fs";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

if (!GITHUB_TOKEN) {
  console.log("GITHUB_TOKEN not set, skipping shade-web download");
  process.exit(0);
}

const targetDir = "public/app";
mkdirSync(targetDir, { recursive: true });

const releaseRes = await fetch(`https://api.github.com/repos/luckydye/shade/releases`, {
  headers: {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
  },
});

if (!releaseRes.ok) {
  throw new Error(`GitHub API returned ${releaseRes.status}`);
}

try {
  const releases = await releaseRes.json();
  const release = releases[0];
  const asset = release.assets.find((a) => a.name === "shade-web.tar.gz");

  if (!asset) {
    throw new Error("Could not find shade-web.tar.gz asset");
  }

  const archivePath = `${targetDir}/shade-web.tar.gz`;
  const file = Bun.file(
    `https://api.github.com/repos/tihav/shade/releases/assets/${asset.id}`,
    {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: "application/octet-stream",
      },
    },
  );

  await file.save(archivePath);

  const tar = Bun.spawn(["tar", "-xz", "--strip-components=1", "-C", targetDir], {
    stdin: "inherit",
  });

  await tar.exited;
} catch (err) {
  console.warn(`Warning: Could not download shade-web: ${err.message}`);
}
