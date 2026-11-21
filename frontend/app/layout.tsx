import type { ReactNode } from "react";

export const metadata = {
  title: "Pisces",
  description: "Docker and Kubernetes control plane",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
