const features = [
  {
    title: "Unified entry",
    body: "createApp wires wallet, storage, and bulletin APIs behind a single object.",
  },
  {
    title: "Host-integrated",
    body: "Runs inside Polkadot Desktop and Mobile. Host accounts, host storage, host permissions — no extension setup.",
  },
  {
    title: "Typed chains",
    body: "PAPI-generated descriptors for Asset Hub, Bulletin, Paseo, Kusama. Add your own.",
  },
  {
    title: "Tx lifecycle",
    body: "Submit, watch finalization, batch, retry. Structured errors, no opaque failures.",
  },
  {
    title: "Multi-provider signing",
    body: "Host provider in production, Dev provider for local tests. One SignerManager across both.",
  },
  {
    title: "Content-addressed storage",
    body: "Upload, pin, and retrieve via the Polkadot Bulletin Chain with CID computation.",
  },
];

export function FeatureGrid() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-6">
      {features.map((f) => (
        <div
          key={f.title}
          className="bg-surface-container rounded-container p-6"
        >
          <h3 className="font-semibold text-base leading-tight text-primary">
            {f.title}
          </h3>
          <p className="text-secondary text-sm mt-2 leading-relaxed">
            {f.body}
          </p>
        </div>
      ))}
    </div>
  );
}
