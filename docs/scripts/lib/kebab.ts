export function kebab(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .toLowerCase()
    .replace(/^-+|-+$/g, "");
}

export function packageSlug(packageName: string): string {
  if (packageName === "@parity/product-sdk") return "sdk";
  return packageName.replace(/^@parity\/product-sdk-/, "");
}
