/**
 * Seeds a development database with categories, creators and templates.
 * All cover art is original abstract artwork generated here; no third-party media.
 * Refuses to run against a database that already has templates.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { sql } from "drizzle-orm";
import { applyMovement } from "@/server/credits/ledger";
import { closeDb, getDb } from "@/server/db";
import {
  creatorProfiles,
  creditAccounts,
  favorites,
  follows,
  mediaAssets,
  templateCategories,
  templateCollectionItems,
  templateCollections,
  templateRatings,
  templates,
  templateVersions,
  userPreferences,
  userProfiles,
  users,
} from "@/server/db/schema";
import { hashPassword } from "@/server/auth/session";
import { newStorageKey, sha256, storage } from "@/server/storage";

const db = getDb();

const [{ n }] = (await db.execute<{ n: number }>(sql`select count(*)::int as n from templates`)) as unknown as [{ n: number }];
if (n > 0) {
  console.log("Database already has templates; seed skipped.");
  await closeDb();
  process.exit(0);
}

const password = process.env.SEED_PASSWORD ?? randomBytes(9).toString("base64url");

const CATEGORIES = [
  ["boudoir", "Boudoir"],
  ["nightlife", "Nightlife"],
  ["romance", "Romance"],
  ["couples", "Couples"],
  ["glamour", "Glamour"],
  ["fantasy", "Fantasy"],
  ["cosplay", "Cosplay"],
  ["motion", "Solo motion"],
  ["restyle", "Restyle"],
] as const;

const CREATORS = [
  ["lunavelour", "Luna Velour", "Warm light, soft fabric, slow cameras."],
  ["atelier_noir", "Atelier Noir", "High-contrast glamour and noir sets."],
  ["mx_ember", "Mx Ember", "Nightlife, neon and movement."],
  ["softfocus", "Soft Focus", "Romance and quiet intimacy."],
  ["nightcartographer", "Night Cartographer", "Fantasy worlds after dark."],
] as const;

type Seed = {
  title: string;
  cat: (typeof CATEGORIES)[number][0];
  by: number;
  media: "image" | "video";
  mode: "text_to_image" | "image_to_image" | "text_to_video" | "image_to_video" | "reference_guided";
  tags: string[];
  vip?: boolean;
  q?: "hd" | "4k";
  dur?: number;
  prompt: string;
  aspect: string;
  extra?: Record<string, unknown>;
  hue: number;
};

const T: Seed[] = [
  { title: "Velvet Hour", cat: "boudoir", by: 0, media: "image", mode: "text_to_image", tags: ["golden hour", "silk", "warm"], prompt: "adult woman lounging on a velvet chaise at golden hour, silk robe, warm film grain, soft focus", aspect: "4:5", hue: 28 },
  { title: "Slow Burn Turn", cat: "motion", by: 2, media: "video", mode: "image_to_video", tags: ["turn", "slow", "portrait"], dur: 5, prompt: "the subject turns slowly toward camera with a knowing smile, hair catching the light", aspect: "9:16", extra: { cameraMovement: "slow push in", motionIntensity: 4 }, hue: 12 },
  { title: "Neon Afterparty", cat: "nightlife", by: 2, media: "video", mode: "text_to_video", tags: ["neon", "club", "dance"], vip: true, dur: 8, prompt: "two adults dancing close in a neon-lit lounge, haze, magenta and teal light", aspect: "9:16", extra: { cameraMovement: "orbit", motionIntensity: 6 }, hue: 310 },
  { title: "Silk Sheets Pan", cat: "boudoir", by: 0, media: "video", mode: "image_to_video", tags: ["silk", "bedroom", "slow"], dur: 5, prompt: "camera glides along silk sheets toward the subject, morning light through linen curtains", aspect: "16:9", extra: { cameraMovement: "pan right", motionIntensity: 3 }, hue: 35 },
  { title: "Candlelit Portrait", cat: "romance", by: 3, media: "image", mode: "image_to_image", tags: ["candle", "portrait", "warm"], prompt: "restyle as an intimate candlelit portrait, deep amber shadows, painterly texture", aspect: "4:5", hue: 22 },
  { title: "Mirror Glow", cat: "glamour", by: 1, media: "image", mode: "image_to_image", tags: ["mirror", "selfie", "glow"], prompt: "mirror selfie restyled with a soft bloom glow and chrome highlights", aspect: "9:16", hue: 200 },
  { title: "Rooftop Sway", cat: "nightlife", by: 2, media: "video", mode: "text_to_video", tags: ["rooftop", "city", "dance"], dur: 5, prompt: "an adult woman sways to music on a rooftop at dusk, city lights behind, wind in her dress", aspect: "9:16", extra: { cameraMovement: "handheld", motionIntensity: 5 }, hue: 260 },
  { title: "Poolside Polaroid", cat: "glamour", by: 3, media: "image", mode: "text_to_image", tags: ["pool", "summer", "film"], prompt: "poolside instant-film snapshot of an adult couple, overexposed summer light, faded colors", aspect: "1:1", hue: 185 },
  { title: "Masquerade", cat: "fantasy", by: 4, media: "image", mode: "text_to_image", tags: ["mask", "gala", "gold"], vip: true, q: "4k", prompt: "adult guests at a candlelit masquerade, ornate gold masks, velvet and smoke", aspect: "2:3", hue: 45 },
  { title: "Steam & Shadow", cat: "motion", by: 1, media: "video", mode: "image_to_video", tags: ["steam", "shadow", "noir"], dur: 5, prompt: "steam drifts across a tiled wall, the subject half in shadow, slow breathing motion", aspect: "9:16", extra: { cameraMovement: "static", motionIntensity: 3 }, hue: 210 },
  { title: "Lace & Light", cat: "boudoir", by: 0, media: "image", mode: "text_to_image", tags: ["lace", "window", "airy"], q: "4k", prompt: "adult model in ivory lace by a tall window, high-key airy light, editorial boudoir", aspect: "4:5", hue: 40 },
  { title: "Slow Dance", cat: "couples", by: 3, media: "video", mode: "text_to_video", tags: ["couple", "dance", "romantic"], dur: 8, prompt: "an adult couple slow dancing in a dim living room, foreheads touching, warm lamp light", aspect: "16:9", extra: { cameraMovement: "orbit", motionIntensity: 3 }, hue: 15 },
  { title: "Elven Enchantress", cat: "fantasy", by: 4, media: "image", mode: "text_to_image", tags: ["elf", "forest", "glow"], prompt: "an adult elven enchantress in a moonlit glade, bioluminescent flowers, flowing sheer gown", aspect: "2:3", hue: 150 },
  { title: "Latex Noir", cat: "glamour", by: 1, media: "image", mode: "text_to_image", tags: ["latex", "noir", "studio"], vip: true, prompt: "high-contrast studio portrait in black latex, single hard light, deep black background", aspect: "4:5", hue: 350 },
  { title: "Morning Coffee", cat: "romance", by: 3, media: "image", mode: "text_to_image", tags: ["morning", "cozy", "bed"], prompt: "adult couple sharing coffee in bed on a lazy morning, oversized shirt, soft window light", aspect: "4:5", hue: 30 },
  { title: "Hotel Window", cat: "motion", by: 0, media: "video", mode: "image_to_video", tags: ["hotel", "city", "window"], vip: true, dur: 5, prompt: "the subject leans against a hotel window at night, city bokeh, slow look over the shoulder", aspect: "9:16", extra: { cameraMovement: "slow push in", motionIntensity: 4 }, hue: 230 },
  { title: "Pin-up Restyle", cat: "restyle", by: 1, media: "image", mode: "image_to_image", tags: ["retro", "pin-up", "illustration"], prompt: "restyle as a 1950s pin-up illustration, gouache texture, cherry red palette", aspect: "3:4", hue: 5 },
  { title: "Cyber Siren", cat: "cosplay", by: 4, media: "image", mode: "text_to_image", tags: ["cyberpunk", "cosplay", "neon"], prompt: "adult cosplayer as a cyberpunk siren, holographic bodysuit, rain-soaked neon alley", aspect: "2:3", hue: 290 },
  { title: "Whisper", cat: "motion", by: 3, media: "video", mode: "image_to_video", tags: ["close-up", "lips", "slow"], dur: 3, prompt: "extreme close-up, the subject whispers toward camera, shallow focus, warm skin tones", aspect: "1:1", extra: { cameraMovement: "static", motionIntensity: 2 }, hue: 18 },
  { title: "Shoreline Walk", cat: "couples", by: 2, media: "video", mode: "text_to_video", tags: ["beach", "sunset", "walk"], dur: 8, prompt: "an adult couple walks hand in hand along the shoreline at sunset, waves at their feet", aspect: "16:9", extra: { cameraMovement: "pan left", motionIntensity: 4 }, hue: 25 },
  { title: "Studio Lights", cat: "glamour", by: 1, media: "image", mode: "text_to_image", tags: ["studio", "beauty", "glossy"], prompt: "glossy beauty-dish portrait of an adult model, wet-look hair, gold jewelry", aspect: "4:5", hue: 48 },
  { title: "Dressing Room", cat: "motion", by: 0, media: "video", mode: "image_to_video", tags: ["mirror", "vanity", "reveal"], dur: 5, prompt: "the subject adjusts a silk robe at a vanity mirror ringed with bulbs, playful glance back", aspect: "9:16", extra: { cameraMovement: "pull back", motionIntensity: 4 }, hue: 340 },
  { title: "Vampire Queen", cat: "fantasy", by: 4, media: "image", mode: "reference_guided", tags: ["gothic", "vampire", "crimson"], prompt: "your character as an adult gothic vampire queen on a crimson throne, candle smoke", aspect: "2:3", hue: 355 },
  { title: "Backstage", cat: "nightlife", by: 2, media: "image", mode: "text_to_image", tags: ["backstage", "flash", "film"], prompt: "direct-flash backstage snapshot, adult performers laughing, sequins and glitter", aspect: "3:4", hue: 280 },
];

function rng(seed: string) {
  let h = createHash("sha256").update(seed).digest();
  let i = 0;
  return () => {
    if (i >= h.length) {
      h = createHash("sha256").update(h).digest();
      i = 0;
    }
    return h[i++]! / 255;
  };
}

function coverSvg(title: string, hue: number, w: number, h: number) {
  const r = rng(title);
  const blobs = Array.from({ length: 7 }, (_, k) => {
    const hh = (hue + (r() - 0.5) * 60 + 360) % 360;
    const l = 30 + r() * 40;
    return `<ellipse cx="${(r() * w).toFixed(0)}" cy="${(r() * h).toFixed(0)}" rx="${(w * (0.15 + r() * 0.35)).toFixed(0)}" ry="${(h * (0.1 + r() * 0.3)).toFixed(0)}" fill="hsl(${hh.toFixed(0)},${(55 + r() * 35).toFixed(0)}%,${l.toFixed(0)}%)" fill-opacity="${(0.5 + r() * 0.5).toFixed(2)}" transform="rotate(${(r() * 180).toFixed(0)} ${w / 2} ${h / 2})"/>`;
  }).join("");
  const sweep = `<path d="M0 ${h * (0.5 + r() * 0.3)} C ${w * 0.3} ${h * r()}, ${w * 0.7} ${h}, ${w} ${h * r()}" stroke="hsl(${hue},90%,85%)" stroke-opacity="0.35" stroke-width="${(w * 0.02).toFixed(0)}" fill="none"/>`;
  // The "loom" motif: a few crisp threads woven across the soft field.
  const threads = Array.from({ length: 5 }, (_, k) => {
    const y0 = h * (0.15 + 0.17 * k + (r() - 0.5) * 0.1);
    const y1 = h * (0.15 + 0.17 * k + (r() - 0.5) * 0.3);
    return `<path d="M${-w * 0.05} ${y0.toFixed(0)} C ${(w * 0.35).toFixed(0)} ${(y0 - h * 0.2 * (r() - 0.3)).toFixed(0)}, ${(w * 0.65).toFixed(0)} ${(y1 + h * 0.2 * (r() - 0.3)).toFixed(0)}, ${(w * 1.05).toFixed(0)} ${y1.toFixed(0)}" stroke="hsl(${(hue + k * 12) % 360},85%,${70 + k * 4}%)" stroke-opacity="${(0.25 + r() * 0.35).toFixed(2)}" stroke-width="${(1 + r() * 2).toFixed(1)}" fill="none"/>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
<defs><filter id="b" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${(w * 0.07).toFixed(0)}"/></filter>
<filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.09 0"/></filter>
<linearGradient id="v" x1="0" y1="0" x2="0" y2="1"><stop offset="0.55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.55"/></linearGradient></defs>
<rect width="100%" height="100%" fill="hsl(${hue},40%,9%)"/>
<g filter="url(#b)">${blobs}${sweep}</g>
${threads}
<circle cx="${(w * (0.25 + r() * 0.5)).toFixed(0)}" cy="${(h * (0.2 + r() * 0.3)).toFixed(0)}" r="${(w * (0.12 + r() * 0.1)).toFixed(0)}" fill="none" stroke="hsl(${(hue + 30) % 360},80%,88%)" stroke-opacity="0.55" stroke-width="1.5"/>
<rect width="100%" height="100%" filter="url(#n)"/>
<rect width="100%" height="100%" fill="url(#v)"/>
</svg>`;
}

function sizeFor(aspect: string, long = 900) {
  const [a, b] = aspect.split(":").map(Number) as [number, number];
  const w = a >= b ? long : Math.round((long * a) / b);
  const h = a >= b ? Math.round((long * b) / a) : long;
  return { w: w - (w % 2), h: h - (h % 2) };
}

async function storeAsset(ownerId: string, kind: "image" | "video", mime: string, bytes: Buffer, w: number, h: number, durationMs?: number) {
  const key = newStorageKey("templates", ownerId, kind === "video" ? "mp4" : "webp");
  await storage().put(key, bytes, mime);
  const [a] = await db
    .insert(mediaAssets)
    .values({ ownerId, kind, storageKey: key, mime, bytes: bytes.length, width: w, height: h, durationMs, sha256: sha256(bytes), visibility: "public" })
    .returning({ id: mediaAssets.id });
  return a!.id;
}

function previewClip(png: Buffer, w: number, h: number, dur: number): Buffer | null {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hl-seed-"));
  try {
    writeFileSync(path.join(dir, "in.png"), png);
    const frames = dur * 24;
    const res = spawnSync("ffmpeg", [
      "-v", "error", "-y", "-loop", "1", "-i", path.join(dir, "in.png"),
      "-vf", `scale=${w * 2}:${h * 2},zoompan=z='min(zoom+0.0015,1.25)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${w}x${h}:fps=24,format=yuv420p`,
      "-t", String(dur), "-c:v", "libx264", "-preset", "veryfast", "-crf", "30", "-movflags", "+faststart", "-an", path.join(dir, "out.mp4"),
    ]);
    if (res.status !== 0) return null;
    return readFileSync(path.join(dir, "out.mp4"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const hash = await hashPassword(password);
async function makeUser(email: string, handle: string, displayName: string, role: "member" | "creator" | "admin", bio = "") {
  const [u] = await db
    .insert(users)
    .values({ email, passwordHash: hash, role, dateOfBirth: "1990-01-01", ageAssuranceMethod: "self_declaration", ageAssuredAt: new Date() })
    .returning();
  await db.insert(userProfiles).values({ userId: u!.id, handle, displayName, bio });
  await db.insert(userPreferences).values({ userId: u!.id });
  await db.insert(creditAccounts).values({ userId: u!.id });
  return u!;
}

const cats = await db
  .insert(templateCategories)
  .values(CATEGORIES.map(([slug, name], i) => ({ slug, name, sortOrder: i })))
  .returning();
const admin = await makeUser("admin@hushloom.local", "hushloom", "Hushloom", "admin", "Official templates and announcements.");
const creators = [];
for (const [handle, name, bio] of CREATORS) {
  const u = await makeUser(`${handle}@hushloom.local`, handle, name, "creator", bio);
  await db.insert(creatorProfiles).values({ userId: u.id, headline: bio, shareAnalytics: true });
  creators.push(u);
}
const member = await makeUser("demo@hushloom.local", "demo_member", "Demo Member", "member");
await db.transaction((tx) =>
  applyMovement(tx, { userId: member.id, kind: "admin_adjust", availableDelta: 200, reservedDelta: 0, idempotencyKey: `seed:${member.id}`, note: "Seed credits" }),
);

const created: string[] = [];
for (const [i, s] of T.entries()) {
  const creator = creators[s.by]!;
  const { w, h } = sizeFor(s.aspect);
  const png = await sharp(Buffer.from(coverSvg(s.title, s.hue, w, h))).png().toBuffer();
  const webp = await sharp(png).webp({ quality: 82 }).toBuffer();
  const posterId = await storeAsset(creator.id, "image", "image/webp", webp, w, h);
  let previewId: string | undefined;
  if (s.media === "video") {
    const small = sizeFor(s.aspect, 480);
    const clip = previewClip(await sharp(png).resize(small.w, small.h).png().toBuffer(), small.w, small.h, 3);
    if (clip) previewId = await storeAsset(creator.id, "video", "video/mp4", clip, small.w, small.h, 3000);
  }
  const publishedAt = new Date(Date.now() - (i % 12) * 86_400_000 * 1.5);
  const [t] = await db
    .insert(templates)
    .values({
      slug: s.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, ""),
      creatorId: creator.id,
      categoryId: cats.find((c) => c.slug === s.cat)!.id,
      title: s.title,
      description: s.prompt.charAt(0).toUpperCase() + s.prompt.slice(1) + ".",
      mediaType: s.media,
      mode: s.mode,
      tags: s.tags,
      status: "published",
      isVip: s.vip ?? false,
      quality: s.q ?? "hd",
      durationS: s.dur,
      posterAssetId: posterId,
      previewAssetId: previewId,
      publishedAt,
    })
    .returning();
  await db.insert(templateVersions).values({
    templateId: t!.id,
    version: 1,
    prompt: s.prompt,
    modelKey: s.media === "video" ? "demo-motion" : "demo-still",
    defaults: { aspectRatio: s.aspect, ...(s.dur ? { durationS: s.dur } : {}), ...(s.q ? { quality: s.q } : {}), ...(s.extra ?? {}) },
  });
  created.push(t!.id);
}

// Deterministic community signals so the sort tabs have something to sort.
const voters = [member, ...creators];
const r = rng("signals");
for (const tid of created) {
  for (const v of voters) {
    if (r() < 0.45) await db.insert(favorites).values({ userId: v.id, targetType: "template", targetId: tid }).onConflictDoNothing();
    if (r() < 0.5) await db.insert(templateRatings).values({ userId: v.id, templateId: tid, score: 2 + Math.floor(r() * 4) }).onConflictDoNothing();
  }
}
await db.execute(sql`
  update templates t set
    favorite_count = (select count(*) from favorites f where f.target_type = 'template' and f.target_id = t.id),
    rating_sum = coalesce((select sum(score) from template_ratings r where r.template_id = t.id), 0),
    rating_count = (select count(*) from template_ratings r where r.template_id = t.id),
    generation_count = (abs(hashtext(t.slug)) % 400)
`);
await db.insert(follows).values({ followerId: member.id, creatorId: creators[0]!.id });
const [coll] = await db.insert(templateCollections).values({ creatorId: creators[0]!.id, title: "After-dark essentials" }).returning();
await db.insert(templateCollectionItems).values(created.slice(0, 4).map((templateId, position) => ({ collectionId: coll!.id, templateId, position })));

console.log(`Seeded ${created.length} templates, ${creators.length} creators.`);
console.log(`Accounts (password for all: ${process.env.SEED_PASSWORD ? "$SEED_PASSWORD" : password}):`);
console.log(`  admin@hushloom.local (admin), demo@hushloom.local (member, 200 credits), ${CREATORS.map((c) => `${c[0]}@hushloom.local`).join(", ")}`);
void admin;
await closeDb();
process.exit(0);
