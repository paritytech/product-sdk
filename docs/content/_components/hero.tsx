export function Hero() {
  return (
    <div className="max-w-4xl pt-8 pb-12">
      <h1 className="font-display text-5xl leading-tight text-primary">
        Product SDK
      </h1>
      <div className="mt-4 text-lg text-secondary max-w-2xl">
        Typed APIs for chain interactions, transaction signing, key
        management, and storage across Polkadot Desktop, Mobile, and browser
        environments.
      </div>
      <div className="mt-8 flex items-center gap-3">
        <a
          href="/getting-started/quickstart"
          className="bg-action-primary text-primary-inverted font-medium text-sm px-4 py-2 rounded-small hover:bg-action-primary-hover transition-colors cursor-pointer"
        >
          Quickstart
        </a>
        <a
          href="/api/sdk/create-app"
          className="bg-action-secondary text-primary font-medium text-sm px-4 py-2 rounded-small hover:bg-action-secondary-hover transition-colors cursor-pointer"
        >
          API Reference
        </a>
      </div>
    </div>
  );
}
