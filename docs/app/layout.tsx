import type { Metadata } from "next";
import { Inter, DM_Serif_Display } from "next/font/google";
import { Layout, Navbar } from "nextra-theme-docs";
import { Head, Search } from "nextra/components";
import { getPageMap } from "nextra/page-map";
import { Logo } from "./_components/logo";
import { PreserveHostParams } from "./_components/preserve-host-params";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
});

const dmSerif = DM_Serif_Display({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-dm-serif",
});

export const metadata: Metadata = {
  title: {
    default: "Product SDK",
    template: "%s — Product SDK",
  },
  description:
    "TypeScript SDK for building products in the Polkadot ecosystem.",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const pageMap = await getPageMap();

  const navbar = (
    <Navbar
      logo={<Logo />}
      projectLink="https://github.com/paritytech/product-sdk"
    />
  );

  return (
    <html
      lang="en"
      dir="ltr"
      suppressHydrationWarning
      className={`${inter.variable} ${dmSerif.variable}`}
    >
      <Head />
      <body className="bg-surface-main text-primary font-sans antialiased">
        <PreserveHostParams />
        <Layout
          navbar={navbar}
          pageMap={pageMap}
          docsRepositoryBase="https://github.com/paritytech/product-sdk/tree/main/docs"
          sidebar={{ defaultMenuCollapseLevel: 1 }}
          search={<Search />}
          footer={null}
        >
          {children}
        </Layout>
      </body>
    </html>
  );
}
