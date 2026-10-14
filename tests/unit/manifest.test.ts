import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

type Icon = { src: string; sizes: string; type: string; purpose?: string };
type Manifest = {
  id?: string;
  name: string;
  short_name: string;
  description: string;
  start_url: string;
  scope: string;
  display: string;
  background_color: string;
  theme_color: string;
  prefer_related_applications?: boolean;
  icons: Icon[];
  categories?: string[];
};

const root = path.resolve(__dirname, "../..");
const publicFile = (src: string) => path.join(root, "public", src.replace(/^\//, ""));
const manifest = JSON.parse(readFileSync(publicFile("/manifest.webmanifest"), "utf8")) as Manifest;
const css = readFileSync(path.join(root, "src/app/globals.css"), "utf8");
const ink950 = css.match(/--color-ink-950:\s*(#[0-9a-f]{6})/i)?.[1];

const purposes = (icon: Icon) => (icon.purpose ?? "any").split(/\s+/);
const pngIcon = (size: number, purpose: string) => manifest.icons.find((i) => i.type === "image/png" && i.sizes.split(/\s+/).includes(`${size}x${size}`) && purposes(i).includes(purpose));

describe("web app manifest", () => {
  it("has the fields browsers require to offer install", () => {
    expect(manifest.name).toBe("Hushloom");
    expect(manifest.short_name).toBe("Hushloom");
    expect(manifest.description.length).toBeGreaterThan(10);
    expect(manifest.start_url).toBe("/");
    expect(manifest.scope).toBe("/");
    expect(manifest.display).toBe("standalone");
    expect(manifest.prefer_related_applications ?? false).toBe(false);
    expect(manifest.categories?.length).toBeGreaterThan(0);
  });

  it("uses the ink background from the design tokens for the splash and the browser chrome", () => {
    expect(ink950).toBeTruthy();
    expect(manifest.background_color.toLowerCase()).toBe(ink950!.toLowerCase());
    expect(manifest.theme_color.toLowerCase()).toBe(ink950!.toLowerCase());
  });

  it("lists 192 and 512 icons for any purpose and a 512 maskable icon, and each file exists at its declared size", async () => {
    const wanted = [pngIcon(192, "any"), pngIcon(512, "any"), pngIcon(512, "maskable")];
    for (const icon of wanted) {
      expect(icon).toBeTruthy();
      const file = publicFile(icon!.src);
      expect(existsSync(file)).toBe(true);
      const meta = await sharp(file).metadata();
      expect(meta.format).toBe("png");
      expect(`${meta.width}x${meta.height}`).toBe(icon!.sizes);
    }
    for (const icon of manifest.icons) expect(existsSync(publicFile(icon.src))).toBe(true);
  });

  it("the maskable icon is opaque edge to edge, so launchers can crop it to any shape", async () => {
    const { data, info } = await sharp(publicFile(pngIcon(512, "maskable")!.src)).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const alphaAt = (x: number, y: number) => data[(y * info.width + x) * info.channels + 3];
    for (const [x, y] of [[0, 0], [511, 0], [0, 511], [511, 511], [256, 0]] as const) expect(alphaAt(x, y)).toBe(255);
  });

  it("the root layout links the manifest, the Apple touch icon and the home-screen meta, and the files exist", () => {
    const layout = readFileSync(path.join(root, "src/app/layout.tsx"), "utf8");
    expect(layout).toContain('manifest: "/manifest.webmanifest"');
    expect(layout).toContain('"/icons/apple-touch-icon.png"');
    expect(layout).toContain('"apple-mobile-web-app-capable": "yes"');
    expect(layout).toMatch(/appleWebApp: \{ capable: true/);
    expect(layout).toContain(`themeColor: "${ink950}"`);
    expect(existsSync(publicFile("/icons/apple-touch-icon.png"))).toBe(true);
  });

  it("every file the service worker precaches exists", () => {
    const context = vm.createContext({ self: { location: { origin: "https://hushloom.test", href: "https://hushloom.test/sw.js" }, addEventListener: () => undefined }, URL });
    vm.runInContext(readFileSync(publicFile("/sw.js"), "utf8"), context);
    const shell = vm.runInContext("SHELL_URLS", context) as string[];
    expect(shell).toContain("/manifest.webmanifest");
    for (const url of shell) expect(existsSync(publicFile(url)), url).toBe(true);
  });

  it("next.config serves the worker uncached with an origin-wide scope", () => {
    const config = readFileSync(path.join(root, "next.config.ts"), "utf8");
    expect(config).toMatch(/source: "\/sw\.js"/);
    expect(config).toContain('{ key: "Service-Worker-Allowed", value: "/" }');
    expect(config).toContain('{ key: "Cache-Control", value: "no-cache" }');
  });
});
