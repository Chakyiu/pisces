import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Pisces",
    short_name: "Pisces",
    description: "Docker console with an authenticated Rust API backend",
    start_url: "/",
    display: "standalone",
    background_color: "#0B1120",
    theme_color: "#0B1120",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
