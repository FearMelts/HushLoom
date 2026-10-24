# Playbox preview

A no-dependency, responsive creative-playground prototype. It demonstrates template discovery and personalization while clearly identifying generation and account features that are not connected.

## Run locally

Requires Node.js 18 or newer.

```sh
npm test
npm start
```

Open <http://127.0.0.1:4173>. Favorites, recently viewed templates, and edited prompts/settings are saved in this browser only. **No media is uploaded, no AI job is submitted, and no credits are charged.**

Read [the Playbox 2.0 product vision](docs/playbox-2-vision.md) and [engineering notes and verification report](docs/engineering.md) for design assumptions, intended architecture, and the implementation boundary.

## NOIR Creator Studio

A separate, standalone pair of pages that need no build step or server. Open either file directly in a browser, or serve the folder with any static server.

- [`noir-landing.html`](noir-landing.html): marketing site that embeds the studio live.
- [`noir-studio.html`](noir-studio.html): the studio. Seeded and reproducible procedural renders, 1/2/4 variations, six aspect ratios, a 100-item IndexedDB library (migrates the old v1 localStorage library), lightbox, bulk actions, undo, backup and restore, four accent themes, keyboard shortcuts, and an optional bring-your-own generation endpoint. Deep link to a template with `noir-studio.html#template=ocean`.
- [`noir-assets/`](noir-assets): sample renders used by the landing page, exported from the studio's own renderer.

The built-in renderer produces procedural artwork, not AI images. Connect your own endpoint in Settings for real generation (see the request contract on the Settings page).
