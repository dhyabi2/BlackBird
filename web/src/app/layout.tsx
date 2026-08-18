import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Nav } from "@/components/Nav";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "BlackBird — Nano Privacy Pool",
  description:
    "Production web client for the BlackBird zero-knowledge privacy pool on Nano.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-white text-black">
        <Nav />
        <main className="flex-1">{children}</main>
        <footer className="border-t border-black/10 py-6 text-center text-sm text-black/50">
          BlackBird
        </footer>
      </body>
    </html>
  );
}
