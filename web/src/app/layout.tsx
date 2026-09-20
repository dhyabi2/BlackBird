import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Nav } from "@/components/Nav";
import { MaintenanceGate } from "@/components/MaintenanceGate";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://www.xblackbird.com"),
  title: {
    default: "BlackBird — Instant Cryptocurrency Privacy Payments",
    template: "%s | BlackBird",
  },
  description:
    "BlackBird is a cryptocurrency privacy payment protocol on Nano (XNO): instant, feeless, private crypto payments protected by zero-knowledge proofs. Send the fastest private cryptocurrency payments with no transaction fees.",
  keywords: [
    "cryptocurrency privacy payment",
    "instant private cryptocurrency payment",
    "fastest private cryptocurrency payment",
    "private crypto payment",
    "anonymous cryptocurrency payment",
    "nano privacy",
    "XNO privacy",
    "private nano transactions",
    "zero-knowledge payments",
    "feeless private cryptocurrency",
    "crypto privacy pool",
    "shielded crypto payments",
    "untraceable crypto payment",
    "instant anonymous payment",
    "BlackBird",
  ],
  applicationName: "BlackBird",
  category: "finance",
  alternates: {
    canonical: "/",
  },
  openGraph: {
    type: "website",
    url: "https://www.xblackbird.com",
    siteName: "BlackBird",
    title: "BlackBird — Instant Cryptocurrency Privacy Payments",
    description:
      "Instant, feeless, private cryptocurrency payments on Nano (XNO), protected by zero-knowledge proofs. The fastest way to send private crypto.",
    images: [{ url: "/icon.png", width: 512, height: 512, alt: "BlackBird" }],
  },
  twitter: {
    card: "summary",
    title: "BlackBird — Instant Cryptocurrency Privacy Payments",
    description:
      "Instant, feeless, private cryptocurrency payments on Nano (XNO), protected by zero-knowledge proofs.",
    images: ["/icon.png"],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
    },
  },
};

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "WebApplication",
  name: "BlackBird",
  url: "https://www.xblackbird.com",
  applicationCategory: "FinanceApplication",
  operatingSystem: "Web",
  description:
    "Cryptocurrency privacy payment protocol on Nano (XNO): instant, feeless, private crypto payments protected by zero-knowledge proofs.",
  offers: {
    "@type": "Offer",
    price: "0",
    priceCurrency: "USD",
  },
  featureList: [
    "Instant cryptocurrency payments (~1 second)",
    "Zero transaction fees",
    "Zero-knowledge privacy (Groth16 proofs)",
    "2-of-3 threshold custody — no single machine holds funds",
    "Fresh unlinkable withdrawal addresses",
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col bg-white text-black">
        <div
          role="status"
          className="border-b-4 border-red-600 bg-red-900 px-4 py-3 text-center text-sm text-white"
        >
          <span className="font-bold tracking-widest">NOT OPERATING</span>
          <span className="opacity-95">
            {" "}&mdash; this service is shut down and is no longer processing
            payments. Please do not send funds.
          </span>
          <span className="mt-1 block opacity-90">
            BlackBird is open source &mdash; anyone interested can run it
            themselves:{" "}
            <a
              href="https://github.com/dhyabi2/BlackBird"
              target="_blank"
              rel="noreferrer"
              className="font-semibold underline underline-offset-2 hover:opacity-80"
            >
              github.com/dhyabi2/BlackBird
            </a>
          </span>
        </div>
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
        <Nav />
        <main className="flex-1">
          <MaintenanceGate>{children}</MaintenanceGate>
        </main>
        <footer className="border-t border-black/10 py-6 text-sm text-black/50">
          <div className="flex items-center justify-center gap-2">
            <span>BlackBird</span>
            <a
              href="https://github.com/dhyabi2/BlackBird"
              target="_blank"
              rel="noreferrer"
              aria-label="BlackBird on GitHub"
              className="text-black/50 transition-colors hover:text-black"
            >
              <svg viewBox="0 0 16 16" width="18" height="18" fill="currentColor" aria-hidden="true">
                <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82a7.42 7.42 0 0 1 2-.27c.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
              </svg>
            </a>
          </div>
        </footer>
      </body>
    </html>
  );
}
