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
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }}
        />
        <Nav />
        <main className="flex-1">{children}</main>
        <footer className="border-t border-black/10 py-6 text-center text-sm text-black/50">
          BlackBird
        </footer>
      </body>
    </html>
  );
}
