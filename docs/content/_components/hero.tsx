export function Hero() {
  return (
    <div className="max-w-4xl pt-8 pb-12">
      <h1 className="font-display text-5xl leading-tight text-primary">
        Product SDK
      </h1>
      <div className="mt-4 text-lg text-secondary max-w-2xl">
        TypeScript SDK for Polkadot apps that run inside a host like Polkadot
        Desktop, Polkadot Mobile, or dot.li. One <code>createApp</code> call
        gives you wallet, storage, and Bulletin in a single object. Leaf
        packages handle chain clients, transactions, keys, and crypto.
      </div>
      <div className="mt-8 flex items-center gap-3">
        <a
          href="/getting-started/installation"
          className="bg-action-primary text-primary-inverted font-medium text-sm px-4 py-2 rounded-small hover:bg-action-primary-hover transition-colors cursor-pointer"
        >
          Installation
        </a>
        <a
          href="/getting-started/quickstart"
          className="bg-action-secondary text-primary font-medium text-sm px-4 py-2 rounded-small hover:bg-action-secondary-hover transition-colors cursor-pointer"
        >
          Quickstart
        </a>
        <a
          href="/api"
          className="bg-action-secondary text-primary font-medium text-sm px-4 py-2 rounded-small hover:bg-action-secondary-hover transition-colors cursor-pointer"
        >
          API Reference
        </a>
      </div>
    </div>
  );
}
