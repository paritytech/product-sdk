import nextra from "nextra";

const withNextra = nextra({
  contentDirBasePath: "/",
  defaultShowCopyCode: true,
});

const basePath = process.env.PAGES_BASE_PATH ?? "";

export default withNextra({
  reactStrictMode: true,
  output: "export",
  images: { unoptimized: true },
  trailingSlash: true,
  basePath,
  assetPrefix: basePath || undefined,
  env: {
    NEXT_PUBLIC_BASE_PATH: basePath,
  },
});
