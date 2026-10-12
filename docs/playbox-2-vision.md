# Playbox 2.0 — Product and Experience Vision

## The idea

Playbox should feel like a creative playground, not a form that happens to make media. A user arrives curious, finds a visual starting point, makes it their own, and has an easy reason to continue. The familiar gallery stays at the center; more capability appears only when it helps.

**Discover → Choose → Personalize → Generate → Remix → Continue → Explore again.**

This repository currently contains a browser-only design prototype, not the connected Playbox product. The experience below is the product direction; the prototype labels the parts that cannot yet run.

## What stays and what evolves

Keep the dark, media-first, template-led experience, clear previews, compact controls, and fast route from browsing to a starting prompt. Evolve discovery with opt-in saved and recently viewed shelves; make templates editable starting points; let advanced controls unfold when wanted; and give each creation a clear path back to exploration.

The prototype uses original abstract artwork, curated starter templates, and “Playbox picks” attribution. That attribution is illustrative, not a real creator identity or published catalog. No personalized recommendation model is active.

## The seven experience systems

1. **AI-powered discovery:** retain categories and visual browsing, then add opt-in For You, related styles, saved inspirations, and recently viewed. Explain and allow clearing discovery signals; never infer sensitive attributes.
2. **Template remix:** defaults should work without a wizard. Editing the prompt, frame, or motion is optional; show materially changed cost or unsupported settings before submission.
3. **Creative copilot:** offer small, contextual suggestions with a preview and undo. Never silently replace user work or interrupt browsing with a chat.
4. **Scene continuity:** provide optional clip history and continuation only when the selected provider supports it. Describe consistency as an aim, never a guarantee; require authorization for adult likeness workflows.
5. **Living collection:** organize private creations, favorites, projects, versions, and downloads around the media itself. Sharing and publishing must always be explicit.
6. **Creator ecosystem:** support attribution, profiles, publishing, following, and moderation only with durable ownership and privacy controls.
7. **Optional Studio:** disclose model controls, estimates, presets, references, and project history progressively. Basic generation must not depend on the Studio.

## Visual and interaction principles

- **Visual hierarchy:** let the preview lead, metadata follow, and controls remain secondary.
- **Personality:** warm, curious, a little imperfect; restrained lime and blush accents against charcoal surfaces.
- **Motion:** small transitions confirm selection, saving, and loading; no decorative loops or autoplay audio. Respect reduced motion.
- **Touch and keyboard:** touch targets, visible focus, keyboard-operable dialogs and filters, and no hover-only functionality.
- **Honesty:** show real loading and job states only when the corresponding backend exists. No fabricated generation progress, output, price, or success.

### Design tokens and hierarchy

The prototype centralizes core values in `styles.css` under `:root`. These are visual assumptions for this empty repository, not extracted from an existing public site:

| Token | Preview value |
| --- | --- |
| Background / surface / raised | `#10100f` / `#171715` / `#1d1d1b` |
| Primary / secondary text | `#f1efe8` / `#a5a39b` |
| Accent / accent text | `#d9f36a` / `#1b1e0f` |
| Supporting accent | `#f4a9a3` |
| Card / panel radius | `15px` / `20px` |
| Breakpoints | `1400px`, `900px`, `620px`, `370px` |
| Motion | `160ms`, `260ms`; restrained ease-out |

Use display type for short headlines, sans-serif body type for controls, and compact uppercase labels sparingly. The grid moves from four columns on wide screens to three, two, and one/two on progressively narrower screens. Mobile filters become a horizontal chip row; dialogs become bottom-friendly stacked panels.

## Ideal journey

1. **Discover:** browse a responsive gallery without an account or data-heavy dashboard.
2. **Choose:** open a template to see its preview, description, media type, and starting prompt.
3. **Personalize:** optionally edit the prompt and reveal basic creative settings. Preserve the defaults until the user changes them.
4. **Generate:** server validates eligibility, consent, input compatibility, provider capabilities, entitlements, and available credit; show price and obtain confirmation before reserving credit.
5. **Receive:** display actual provider job status and usable outputs. Explain failures and settle or return reserved credit according to auditable rules.
6. **Continue:** offer variation, retry, download, save, and supported scene continuation.
7. **Return:** connect related public templates and private projects back to Explore.

## Beyond the visible surface

Production quality means private-by-default media, enforceable adult eligibility, authorization and consent, ownership checks, protected uploads, durable jobs, idempotent credit accounting, clear deletion and retention, and accessible, responsive states. Provider capabilities, prices, and model availability must be configured—not invented. Private generations never become public without a separate publishing action.

## Four-phase evolution

1. **Foundation:** recognizable shell, discovery, search, categories, details, private collection, responsive components.
2. **Intelligence and generation:** provider adapters, real jobs and persistence, safe uploads, consent checks, credit ledger, estimates, and optional prompt assistance.
3. **Continuous creativity:** projects, variations, timelines, saved settings, scene continuation, and comparison.
4. **Creator ecosystem:** explicit publishing, profiles, attribution, following, recommendations, and moderation.

## Creative constitution

Preserve the gallery, templates, rapid entry, dark media-first tone, compact patterns, optional experimentation, and original navigation. Do not require chat or advanced settings, interrupt basic browsing for monetization, promise model capabilities that are not real, publish private work by default, or trade away consent, privacy, accessibility, and reliability for engagement.

**Final vision:** the playground remains instantly familiar. Creation is still simple; the system becomes more connected and capable only as the user asks for more.
