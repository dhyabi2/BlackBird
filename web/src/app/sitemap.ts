import type { MetadataRoute } from "next";

const BASE = "https://www.xblackbird.com";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: `${BASE}/`, changeFrequency: "weekly", priority: 1 },
    { url: `${BASE}/easy`, changeFrequency: "weekly", priority: 0.9 },
    { url: `${BASE}/wallet`, changeFrequency: "weekly", priority: 0.8 },
    { url: `${BASE}/deposit`, changeFrequency: "weekly", priority: 0.7 },
    { url: `${BASE}/withdraw`, changeFrequency: "weekly", priority: 0.7 },
    { url: `${BASE}/status`, changeFrequency: "daily", priority: 0.5 },
  ];
}
