/**
 * Renders the installable-app icons (addendum §4) from public/icons/mark.svg, the single source of
 * the logo. The PNGs are committed; re-run after editing the mark:
 *
 *   npx tsx scripts/make-icons.ts
 *
 * Outputs (all in public/icons/):
 * - icon-192.png, icon-512.png    purpose "any": the petal tile as drawn, transparent corners
 * - icon-maskable-512.png         purpose "maskable": full-bleed ink, the glyph inside the 80% safe zone
 * - apple-touch-icon.png (180)    iOS home screen: full-bleed (iOS rounds the corners itself)
 * - icon-32.png                   favicon fallback for browsers without SVG favicons
 * - badge-96.png                  Android notification badge: the glyph in white on transparent
 */
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const DIR = path.resolve("public/icons");

function section(svg: string, name: string): string {
  const match = svg.match(new RegExp(`<!-- ${name}:start -->([\\s\\S]*?)<!-- ${name}:end -->`));
  if (!match?.[1]) throw new Error(`mark.svg has no "${name}" section`);
  return match[1];
}

function topLevelDefs(svg: string): string {
  const match = svg.match(/<defs>[\s\S]*?<\/defs>/);
  if (!match) throw new Error("mark.svg has no <defs>");
  return match[0];
}

const wrap = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">${body}</svg>`;

/** The glyph scaled about the center of the 512 canvas. */
const scaled = (glyph: string, scale: number) => {
  const offset = (512 * (1 - scale)) / 2;
  return `<g transform="translate(${offset} ${offset}) scale(${scale})">${glyph}</g>`;
};

/** Full-bleed square: the tile's ink gradient and glow with no transparent corners. */
function fullBleed(mark: string, scale: number): string {
  return wrap(`${topLevelDefs(mark)}<rect width="512" height="512" fill="url(#hl-ink)"/><rect width="512" height="512" fill="url(#hl-glow)"/>${scaled(section(mark, "glyph"), scale)}`);
}

/** Monochrome badge: every thread in opaque white; the weave cut-outs (masks) stay. */
function badge(mark: string): string {
  const glyph = section(mark, "glyph")
    .replace(/stroke="#(?!fff\b)[0-9a-fA-F]{3,6}"/g, 'stroke="#fff"')
    .replace(/\sstroke-opacity="[^"]*"/g, "");
  return wrap(scaled(glyph, 1.25));
}

async function render(svg: string, size: number, file: string) {
  // 72 dpi renders the 512-unit canvas at 512 px; anything larger renders at a higher density first.
  const density = Math.max(72, Math.ceil((72 * size) / 512));
  await sharp(Buffer.from(svg), { density }).resize(size, size).png({ compressionLevel: 9 }).toFile(path.join(DIR, file));
  console.log(`wrote public/icons/${file} (${size}×${size})`);
}

async function main() {
  await mkdir(DIR, { recursive: true });
  const mark = await readFile(path.join(DIR, "mark.svg"), "utf8");
  await render(mark, 192, "icon-192.png");
  await render(mark, 512, "icon-512.png");
  await render(mark, 32, "icon-32.png");
  // The maskable safe zone is a centered circle 80% of the icon wide; at 0.82 the glyph's corners sit inside it.
  await render(fullBleed(mark, 0.82), 512, "icon-maskable-512.png");
  await render(fullBleed(mark, 0.86), 180, "apple-touch-icon.png");
  await render(badge(mark), 96, "badge-96.png");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
