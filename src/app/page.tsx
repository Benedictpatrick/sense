import Link from "next/link";

export default function Home() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-8 p-6 text-center">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">AbleMind</h1>
        <p className="mt-2 text-neutral-500">Empowering without being limiting</p>
      </div>

      <section className="w-full rounded-lg border border-neutral-200 p-5 text-left">
        <h2 className="text-lg font-semibold">EchoSense</h2>
        <p className="mt-1 text-sm text-neutral-500">
          Adaptive ultrasonic-range sonar for obstacle detection. We&apos;re currently in the data
          collection phase — training the 1D CNN obstacle classifier.
        </p>
        <div className="mt-4 flex gap-2">
          <Link
            href="/infer"
            className="inline-block rounded-md bg-black px-4 py-2 text-sm font-medium text-white"
          >
            Try Live Detection →
          </Link>
          <Link
            href="/collect"
            className="inline-block rounded-md border border-neutral-300 px-4 py-2 text-sm font-medium"
          >
            Collect Data
          </Link>
        </div>
      </section>

      <section className="w-full rounded-lg border border-dashed border-neutral-300 p-5 text-left opacity-60">
        <h2 className="text-lg font-semibold">GestureTalk</h2>
        <p className="mt-1 text-sm text-neutral-500">Sign-language-to-voice. Coming next.</p>
      </section>
    </main>
  );
}
