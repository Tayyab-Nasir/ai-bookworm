import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import localFont from "next/font/local";
import type { ReactNode } from "react";
import "../styles/globals.css";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});

const instrumentSerif = localFont({
  src: "./fonts/instrument-serif-italic.ttf",
  display: "swap",
  style: "italic",
  weight: "400",
  variable: "--font-instrument-serif",
});

export const metadata: Metadata = {
  title: "AI Bookworm — Book Publishing OS",
  description:
    "Publish books with AI agents across writing, editing, illustration, cover design, and multi-platform distribution.",
};

export const viewport: Viewport = {
  colorScheme: "dark",
  themeColor: "#000000",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${inter.variable} ${instrumentSerif.variable} bg-black`}>
      <body className="min-h-screen bg-black font-sans text-white antialiased">{children}</body>
    </html>
  );
}
