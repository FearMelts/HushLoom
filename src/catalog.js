export const templates = [
  {
    id: "moon-motel",
    title: "Moon Motel",
    creator: "Playbox picks",
    category: "Images",
    media: "Image",
    duration: null,
    palette: "moon",
    description: "A roadside daydream, somewhere between the last exit and the moon.",
    prompt: "A tiny roadside motel beneath an enormous peach-colored moon, cinematic dusk, dreamy analog film, quiet and surreal.",
    aspectRatio: "portrait",
    intensity: 1,
  },
  {
    id: "soft-focus",
    title: "Soft Focus",
    creator: "Playbox picks",
    category: "Images",
    media: "Image",
    duration: null,
    palette: "focus",
    description: "A hazy little love letter to the things you almost remember.",
    prompt: "An impressionistic still life caught in soft focus, sun-warmed rose and lilac tones, gentle grain, intimate framing.",
    aspectRatio: "portrait",
    intensity: 1,
  },
  {
    id: "cloud-nine",
    title: "Cloud Nine",
    creator: "Playbox picks",
    category: "Videos",
    media: "Video",
    duration: "5 sec",
    palette: "cloud",
    description: "A slow drift through a sky that couldn't decide on a color.",
    prompt: "Slowly drifting through layered cotton-candy clouds at sunset, soft camera movement, serene and weightless.",
    aspectRatio: "landscape",
    intensity: 1,
  },
  {
    id: "after-hours",
    title: "After Hours",
    creator: "Playbox picks",
    category: "Videos",
    media: "Video",
    duration: "5 sec",
    palette: "after",
    description: "The city, a little quieter. The lights, a little louder.",
    prompt: "A rain-kissed city at midnight, vivid reflections across empty streets, slow tracking shot, cinematic noir.",
    aspectRatio: "landscape",
    intensity: 2,
  },
  {
    id: "petal-study",
    title: "Petal Study",
    creator: "Playbox picks",
    category: "Images",
    media: "Image",
    duration: null,
    palette: "petal",
    description: "An editorial botanical moment with room to breathe.",
    prompt: "Sculptural flowers arranged like a fashion editorial, warm coral and cream, sculpted studio light, elegant composition.",
    aspectRatio: "square",
    intensity: 1,
  },
  {
    id: "velvet-sky",
    title: "Velvet Sky",
    creator: "Playbox picks",
    category: "Videos",
    media: "Video",
    duration: "8 sec",
    palette: "velvet",
    description: "One impossible evening, unfolding one color at a time.",
    prompt: "An otherworldly twilight sky slowly shifting from amber to deep violet, tranquil horizon, graceful cinematic motion.",
    aspectRatio: "landscape",
    intensity: 2,
  },
  {
    id: "little-worlds",
    title: "Little Worlds",
    creator: "Playbox picks",
    category: "Images",
    media: "Image",
    duration: null,
    palette: "worlds",
    description: "A pocket-sized place for a very large imagination.",
    prompt: "A miniature moss-covered house inside a glass terrarium, magical golden-hour lighting, delicate storybook detail.",
    aspectRatio: "square",
    intensity: 1,
  },
  {
    id: "slow-bloom",
    title: "Slow Bloom",
    creator: "Playbox picks",
    category: "Videos",
    media: "Video",
    duration: "8 sec",
    palette: "bloom",
    description: "A tiny pause. A flower taking its own sweet time.",
    prompt: "A single luminous flower opening in a dark room, slow graceful motion, soft directional light, poetic and still.",
    aspectRatio: "portrait",
    intensity: 1,
  },
];

export function filterTemplates(items, {
  query = "",
  category = "For you",
  favorites = [],
  recentlyViewed = [],
} = {}) {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const favoriteIds = new Set(favorites);
  const viewedIds = new Set(recentlyViewed);
  const categoryFiltered = items.filter((item) => {
    if (category === "Images" || category === "Videos") return item.category === category;
    if (category === "Saved") return favoriteIds.has(item.id);
    if (category === "Recently viewed") return viewedIds.has(item.id);
    return true;
  });

  if (!normalizedQuery) return categoryFiltered;

  return categoryFiltered.filter((item) =>
    [item.title, item.creator, item.category, item.description]
      .some((value) => value.toLocaleLowerCase().includes(normalizedQuery)),
  );
}
