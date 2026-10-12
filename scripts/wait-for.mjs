// Waits until a URL answers 2xx (up to 10 minutes). Usage: node scripts/wait-for.mjs <url>
const url = process.argv[2];
for (let i = 0; i < 600; i++) {
  try {
    if ((await fetch(url)).ok) process.exit(0);
  } catch {}
  await new Promise((r) => setTimeout(r, 1000));
}
console.error(`timed out waiting for ${url}`);
process.exit(1);
