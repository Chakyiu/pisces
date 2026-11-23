import type { ReactNode } from "react";
import { IBM_Plex_Sans, JetBrains_Mono } from "next/font/google";
import { SessionProvider } from "../components/session";
import "./tokens.css";
import "./globals.css";

const ui = IBM_Plex_Sans({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-ui" });
const mono = JetBrains_Mono({ subsets: ["latin"], weight: ["400"], variable: "--font-code" });

const themeScript = `(function(){try{var t=localStorage.getItem("pisces.theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t);}catch(e){}})();`;

export const metadata = {
  title: "Pisces",
  description: "Docker and Kubernetes control plane",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className={`${ui.variable} ${mono.variable}`}>
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  );
}