import test from "node:test";
import assert from "node:assert/strict";
import { filterTemplates, templates } from "../src/catalog.js";

test("the catalog contains discoverable image and video templates", () => {
  assert.ok(templates.some((template) => template.category === "Images"));
  assert.ok(templates.some((template) => template.category === "Videos"));
  assert.ok(templates.every((template) => template.id && template.prompt));
});

test("category filters show only matching media", () => {
  assert.ok(filterTemplates(templates, { category: "Images" }).every((template) => template.category === "Images"));
  assert.ok(filterTemplates(templates, { category: "Videos" }).every((template) => template.category === "Videos"));
});

test("search is case-insensitive and ignores surrounding whitespace", () => {
  assert.deepEqual(
    filterTemplates(templates, { query: "  MOON " }).map((template) => template.id),
    ["moon-motel"],
  );
});

test("saved and recently viewed filters respect their local identifiers", () => {
  assert.deepEqual(
    filterTemplates(templates, { category: "Saved", favorites: ["petal-study"] }).map((template) => template.id),
    ["petal-study"],
  );
  assert.deepEqual(
    filterTemplates(templates, { category: "Recently viewed", recentlyViewed: ["cloud-nine"] }).map((template) => template.id),
    ["cloud-nine"],
  );
});

test("a search is combined with the selected category", () => {
  assert.deepEqual(
    filterTemplates(templates, { query: "bloom", category: "Videos" }).map((template) => template.id),
    ["slow-bloom"],
  );
});
