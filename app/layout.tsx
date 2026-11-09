import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ChurchPay",
  description: "Easy payments for church events",
  robots: { index: false, follow: false },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="de">
      <body className="font-sans">{children}</body>
    </html>
  );
}
