export function Logo() {
  return (
    <div className="flex items-center h-8">
      <img
        src="/logo-symbol-wordmark_dark.svg"
        alt="Polkadot"
        className="block dark:hidden h-7 w-auto"
      />
      <img
        src="/logo-symbol-wordmark_light.svg"
        alt="Polkadot"
        className="hidden dark:block h-7 w-auto"
      />
      <span className="ml-3 font-semibold text-sm text-secondary">
        Product SDK
      </span>
    </div>
  );
}
