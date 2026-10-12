import { filterTemplates, templates } from "./catalog.js";

const storageKeys = {
  favorites: "playbox.favorites.v1",
  recentlyViewed: "playbox.recentlyViewed.v1",
  edits: "playbox.edits.v1",
};

const state = {
  category: "For you",
  query: "",
  view: "explore",
  selectedTemplate: null,
  favorites: readStorage(storageKeys.favorites, []),
  recentlyViewed: readStorage(storageKeys.recentlyViewed, []),
  edits: readStorage(storageKeys.edits, {}),
};

const grid = document.querySelector("#template-grid");
const dialog = document.querySelector("#template-dialog");
const search = document.querySelector("#search");
const toast = document.querySelector("#toast");
let toastTimer;

function readStorage(key, fallback) {
  try {
    const stored = JSON.parse(localStorage.getItem(key));
    return stored ?? fallback;
  } catch {
    return fallback;
  }
}

function saveStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    showToast("Your browser couldn't save this on this device.");
  }
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function render() {
  const activeCategory = state.view === "collection" ? "Saved" : state.category;
  const visible = filterTemplates(templates, {
    query: state.query,
    category: activeCategory,
    favorites: state.favorites,
    recentlyViewed: state.recentlyViewed,
  });

  grid.innerHTML = visible.map(renderCard).join("");
  document.querySelector("#empty-state").hidden = visible.length > 0;
  document.querySelector("#result-count").textContent = `${visible.length} ${visible.length === 1 ? "starting point" : "starting points"}`;
  document.querySelector("#saved-count").textContent = state.favorites.length;
  document.querySelector("#chip-saved-count").textContent = state.favorites.length;
  document.querySelector("#gallery-title").innerHTML = state.view === "collection"
    ? 'Your saved sparks<span class="heading-dot">.</span>'
    : state.category === "Recently viewed"
      ? 'Picking up where you left off<span class="heading-dot">.</span>'
      : state.category === "Saved"
        ? 'Your saved sparks<span class="heading-dot">.</span>'
        : state.category === "Images"
          ? 'Little worlds, still<span class="heading-dot">.</span>'
          : state.category === "Videos"
            ? 'A little motion<span class="heading-dot">.</span>'
            : 'Made for wandering<span class="heading-dot">.</span>';
  document.querySelector("#gallery-kicker").textContent = state.view === "collection"
    ? "KEPT CLOSE, FOR LATER"
    : state.category === "Recently viewed"
      ? "YOUR RECENT EXPLORATIONS"
      : state.category === "Saved"
        ? "KEPT CLOSE, FOR LATER"
        : "A FRESH BATCH OF INSPIRATION";
  document.querySelector("#clear-history").hidden = state.category !== "Recently viewed";
  document.querySelector("#welcome").hidden = state.view === "collection";
  document.querySelectorAll("[data-view-link]").forEach((link) => {
    const active = link.dataset.viewLink === state.view;
    link.classList.toggle("is-active", active);
    if (active) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  document.querySelectorAll("[data-category]").forEach((button) => {
    const active = button.dataset.category === state.category;
    button.classList.toggle("is-selected", active);
    if (button.matches(".side-link, .category-chip")) button.setAttribute("aria-pressed", String(active));
  });
  document.querySelector("#clear-filters").hidden = state.category === "For you" && state.view === "explore" && !state.query;
}

function renderCard(item) {
  const isFavorite = state.favorites.includes(item.id);
  const mediaTag = item.duration
    ? `<span class="media-tag"><span aria-hidden="true">▷</span> ${item.duration}</span>`
    : '<span class="media-tag">IMAGE</span>';
  return `
    <article class="template-card">
      <div class="card-art art-${item.palette}">
        <button class="art-open" type="button" data-open="${item.id}" aria-label="View ${escapeHtml(item.title)} template details">
          <span class="art-shape shape-one"></span>
          <span class="art-shape shape-two"></span>
          <span class="art-shape shape-three"></span>
          <span class="art-horizon"></span>
          <span class="art-caption">${escapeHtml(item.title)}</span>
          <span class="art-open-hint">Take a closer look <span aria-hidden="true">↗</span></span>
        </button>
        ${mediaTag}
        <button class="favorite-button${isFavorite ? " is-favorite" : ""}" type="button" data-favorite="${item.id}" aria-label="${isFavorite ? "Remove" : "Save"} ${escapeHtml(item.title)} ${isFavorite ? "from" : "to"} your collection" aria-pressed="${isFavorite}">
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M20.8 8.8c0 4.6-8.8 10-8.8 10s-8.8-5.4-8.8-10A4.8 4.8 0 0 1 12 6.2a4.8 4.8 0 0 1 8.8 2.6Z"></path></svg>
        </button>
        <span class="template-index">${String(templates.indexOf(item) + 1).padStart(2, "0")}</span>
      </div>
      <div class="card-info">
        <div>
          <h3><button class="title-link" type="button" data-open="${item.id}">${escapeHtml(item.title)}</button></h3>
          <p>${escapeHtml(item.description)}</p>
        </div>
        <span class="quick-arrow" aria-hidden="true">↗</span>
      </div>
    </article>`;
}

function openTemplate(id) {
  const item = templates.find((template) => template.id === id);
  if (!item) return;
  state.selectedTemplate = item;
  state.recentlyViewed = [id, ...state.recentlyViewed.filter((viewedId) => viewedId !== id)].slice(0, 12);
  saveStorage(storageKeys.recentlyViewed, state.recentlyViewed);

  document.querySelector("#dialog-art").className = `dialog-art art-${item.palette}`;
  document.querySelector("#dialog-kicker").textContent = `${item.media.toUpperCase()} TEMPLATE · ${item.category.toUpperCase()}`;
  document.querySelector("#dialog-title").textContent = item.title;
  document.querySelector("#dialog-description").textContent = item.description;
  document.querySelector("#dialog-type").textContent = item.duration ? `${item.media} · ${item.duration}` : item.media;
  document.querySelector("#prompt").value = state.edits[id]?.prompt ?? item.prompt;
  document.querySelector("#aspect-ratio").value = state.edits[id]?.aspectRatio ?? item.aspectRatio;
  document.querySelector("#motion").value = state.edits[id]?.intensity ?? item.intensity;
  document.querySelector("#motion-value").textContent = motionName(Number(document.querySelector("#motion").value));
  document.querySelector("#generation-notice").hidden = true;
  dialog.showModal();
  render();
}

function motionName(value) {
  return ["", "Gentle", "Balanced", "Expressive"][value] ?? "Gentle";
}

function saveEdits() {
  if (!state.selectedTemplate) return;
  state.edits[state.selectedTemplate.id] = {
    prompt: document.querySelector("#prompt").value,
    aspectRatio: document.querySelector("#aspect-ratio").value,
    intensity: Number(document.querySelector("#motion").value),
  };
  saveStorage(storageKeys.edits, state.edits);
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("is-visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 2800);
}

function selectCategory(category) {
  state.view = "explore";
  state.category = category;
  if (location.hash !== "#explore") history.replaceState(null, "", "#explore");
  render();
}

grid.addEventListener("click", (event) => {
  const favoriteButton = event.target.closest("[data-favorite]");
  if (favoriteButton) {
    const { favorite } = favoriteButton.dataset;
    state.favorites = state.favorites.includes(favorite)
      ? state.favorites.filter((id) => id !== favorite)
      : [...state.favorites, favorite];
    saveStorage(storageKeys.favorites, state.favorites);
    render();
    showToast(state.favorites.includes(favorite) ? "Saved to your collection." : "Removed from your collection.");
    return;
  }
  const openButton = event.target.closest("[data-open]");
  if (openButton) openTemplate(openButton.dataset.open);
});

document.querySelectorAll("[data-category]").forEach((button) => {
  button.addEventListener("click", () => selectCategory(button.dataset.category));
});

document.querySelectorAll("[data-view-link]").forEach((link) => {
  link.addEventListener("click", () => {
    state.view = link.dataset.viewLink;
    state.category = state.view === "collection" ? "Saved" : "For you";
    render();
  });
});

search.addEventListener("input", () => {
  state.query = search.value;
  render();
});

search.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    search.value = "";
    state.query = "";
    render();
    search.blur();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "/" && !["INPUT", "TEXTAREA"].includes(document.activeElement.tagName)) {
    event.preventDefault();
    search.focus();
  }
});

document.querySelector("#clear-filters").addEventListener("click", () => {
  state.category = "For you";
  state.view = "explore";
  state.query = "";
  search.value = "";
  render();
});

document.querySelector("#clear-history").addEventListener("click", () => {
  state.recentlyViewed = [];
  saveStorage(storageKeys.recentlyViewed, state.recentlyViewed);
  render();
  showToast("Your recent views were cleared on this device.");
});

document.querySelector(".dialog-close").addEventListener("click", () => dialog.close());
dialog.addEventListener("click", (event) => {
  if (event.target === dialog) dialog.close();
});

document.querySelector("#prompt").addEventListener("input", saveEdits);
document.querySelector("#aspect-ratio").addEventListener("change", saveEdits);
document.querySelector("#motion").addEventListener("input", (event) => {
  document.querySelector("#motion-value").textContent = motionName(Number(event.target.value));
  saveEdits();
});

document.querySelector("#generate-button").addEventListener("click", () => {
  const notice = document.querySelector("#generation-notice");
  notice.textContent = "Generation isn’t connected in this preview. No job was submitted and no credits were charged. Your settings remain saved on this device.";
  notice.hidden = false;
});

window.addEventListener("hashchange", () => {
  state.view = location.hash === "#collection" ? "collection" : "explore";
  state.category = state.view === "collection" ? "Saved" : "For you";
  render();
});

if (location.hash === "#collection") {
  state.view = "collection";
  state.category = "Saved";
}
render();
