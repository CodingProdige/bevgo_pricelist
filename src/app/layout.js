import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import Head from "next/head";
import { Analytics } from "@vercel/analytics/react"


const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const viewport = {
  width: "300", // Forces a wider layout, but still fits within mobile scaling
  initialScale: 0.5, // Zooms out slightly to fit more content on screen
  maximumScale: 1,
  userScalable: false,
};



export const metadata = {
  title: "Bevgo Pricing",
  description: "Realtime product sync and pricing",
  viewport: "width=1024", // Forces desktop-like rendering
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable}`}>
        <Analytics />
        {children}
      </body>
    </html>
  );
}
