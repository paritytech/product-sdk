import nextra from "nextra";

const withNextra = nextra({
  contentDirBasePath: "/",
  defaultShowCopyCode: true,
});

export default withNextra({
  reactStrictMode: true,
  output: "export",
  images: { unoptimized: true },
  trailingSlash: true,
});
