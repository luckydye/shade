// URL transformers extract direct image URLs from service-specific URLs.
// Each transformer matches a URL pattern and returns the direct image URL to fetch.
//
// Usage:
//   const directUrl = transformImageUrl("https://unsplash.com/photos/abc123");
//   if (directUrl) { /* fetch directUrl to get the image bytes */ }

interface UrlTransformer {
  name: string;
  match: (url: URL) => boolean;
  transform: (url: URL) => string;
}

const transformers: UrlTransformer[] = [
  // Unsplash: /photos/<id> -> download endpoint
  {
    name: "unsplash",
    match: (url) =>
      url.hostname === "unsplash.com" && /^\/photos\/[\w-]+/.test(url.pathname),
    transform: (url) => {
      const id = url.pathname.split("/")[2];
      return `https://unsplash.com/photos/${id}/download?force=true`;
    },
  },

  // Unsplash direct image URLs (images.unsplash.com)
  {
    name: "unsplash-direct",
    match: (url) => url.hostname === "images.unsplash.com",
    transform: (url) => url.href,
  },

  // Imgur: /a/<id> or /<id> or /gallery/<id>
  {
    name: "imgur",
    match: (url) =>
      (url.hostname === "imgur.com" || url.hostname === "www.imgur.com") &&
      /^\/(?!a\/|gallery\/)[\w]+$/.test(url.pathname),
    transform: (url) => {
      const id = url.pathname.slice(1);
      return `https://i.imgur.com/${id}.jpg`;
    },
  },

  // Imgur direct (i.imgur.com) — already direct, but ensure extension
  {
    name: "imgur-direct",
    match: (url) => url.hostname === "i.imgur.com",
    transform: (url) => url.href,
  },

  // Flickr: /photos/<user>/<id>
  {
    name: "flickr",
    match: (url) =>
      (url.hostname === "www.flickr.com" || url.hostname === "flickr.com") &&
      /^\/photos\/[\w@-]+\/\d+/.test(url.pathname),
    transform: (url) => {
      const parts = url.pathname.split("/");
      const id = parts[3];
      return `https://www.flickr.com/photos/${parts[2]}/${id}/sizes/o/`;
    },
  },

  // Flickr static (live.staticflickr.com, farm*.staticflickr.com)
  {
    name: "flickr-static",
    match: (url) => url.hostname.endsWith("staticflickr.com"),
    transform: (url) => url.href,
  },

  // Pexels: /photo/<slug>-<id>/
  {
    name: "pexels",
    match: (url) =>
      (url.hostname === "www.pexels.com" || url.hostname === "pexels.com") &&
      url.pathname.startsWith("/photo/"),
    transform: (url) => {
      const match = url.pathname.match(/(\d+)\/?$/);
      if (!match) return url.href;
      return `https://images.pexels.com/photos/${match[1]}/pexels-photo-${match[1]}.jpeg?auto=compress&cs=tinysrgb&w=1260`;
    },
  },

  // Reddit: i.redd.it direct images
  {
    name: "reddit-direct",
    match: (url) => url.hostname === "i.redd.it",
    transform: (url) => url.href,
  },

  // Reddit: preview.redd.it/<slug> -> i.redd.it/<id>.jpg
  // Last segment of the slug (split by "-") is the image id.
  {
    name: "reddit-preview",
    match: (url) => url.hostname === "preview.redd.it",
    transform: (url) => {
      const slug = url.pathname.split("/").filter(Boolean)[0] || "";
      const idWithExt = slug.split("-").pop() || slug;
      return `https://i.redd.it/${idWithExt}`;
    },
  },

  // Instagram post URLs — Rust resolves og:image from the HTML response
  {
    name: "instagram",
    match: (url) =>
      (url.hostname === "www.instagram.com" ||
        url.hostname === "instagram.com") &&
      /^\/(p|reel)\/[\w-]+/.test(url.pathname),
    transform: (url) => url.href,
  },

  // Instagram CDN (cdninstagram.com) — direct image
  {
    name: "instagram-cdn",
    match: (url) => url.hostname.endsWith("cdninstagram.com"),
    transform: (url) => url.href,
  },

  // Wikipedia/Wikimedia Commons file URLs
  {
    name: "wikimedia",
    match: (url) =>
      url.hostname === "upload.wikimedia.org" ||
      url.hostname === "commons.wikimedia.org",
    transform: (url) => url.href,
  },

  // Twitter/X image CDN (pbs.twimg.com) — format is in query string
  {
    name: "twitter-image",
    match: (url) => url.hostname === "pbs.twimg.com",
    transform: (url) => url.href,
  },

  // Direct image URLs — catch-all, must be last so service-specific
  // transformers get priority (e.g. preview.redd.it URLs end in .jpg).
  {
    name: "direct-image",
    match: (url) =>
      /\.(jpe?g|png|webp|tiff?|avif|heic|bmp|gif)(\?.*)?$/i.test(url.pathname),
    transform: (url) => url.href,
  },
];

// Attempt to transform a pasted URL into a direct image fetch URL.
// Returns null if no transformer matches.
export function transformImageUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }
  for (const transformer of transformers) {
    if (transformer.match(url)) {
      return transformer.transform(url);
    }
  }
  return null;
}

// Extract a reasonable filename from a URL.
export function filenameFromUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "pasted-url-image.jpg";
  }
  const lastSegment = url.pathname.split("/").pop() || "";
  const decoded = decodeURIComponent(lastSegment);
  if (/\.(jpe?g|png|webp|tiff?|avif|heic|bmp|gif)$/i.test(decoded)) {
    return decoded;
  }
  const format = url.searchParams.get("format");
  const ext = format && /^(jpe?g|png|webp|tiff?|avif|gif)$/i.test(format)
    ? format.replace("jpeg", "jpg")
    : "jpg";
  const now = new Date()
    .toISOString()
    .replace(/T/, "-")
    .replace(/:/g, "-")
    .replace(/\.\d+Z$/, "");
  return `url-image-${now}.${ext}`;
}
