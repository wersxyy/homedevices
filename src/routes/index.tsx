import { createFileRoute, Link } from "@tanstack/react-router";
import { Bell, Camera, MessageSquare, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/use-auth";

export const Route = createFileRoute("/")({
  component: Landing,
  head: () => ({
    meta: [
      { title: "HomeDevices — Turn any device into a smart doorbell" },
      { name: "description", content: "Reuse an old phone or tablet as a smart doorbell. See, hear, speak and chat with whoever is at your door." },
    ],
  }),
});

function Landing() {
  const { user } = useAuth();
  return (
    <div className="min-h-screen">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <div className="flex items-center gap-2 font-semibold">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-primary text-primary-foreground">
            <Bell className="h-4 w-4" />
          </div>
          HomeDevices
        </div>
        <nav className="flex items-center gap-2">
          {user ? (
            <Button asChild><Link to="/dashboard">Dashboard</Link></Button>
          ) : (
            <>
              <Button asChild variant="ghost"><Link to="/auth">Sign in</Link></Button>
              <Button asChild><Link to="/auth">Get started</Link></Button>
            </>
          )}
        </nav>
      </header>

      <main className="mx-auto max-w-6xl px-6 pb-24">
        <section className="pt-12 md:pt-24 text-center">
          <span className="inline-flex items-center rounded-full border bg-card px-3 py-1 text-xs text-muted-foreground">
            Smart home, without the smart price
          </span>
          <h1 className="mt-5 text-balance text-4xl font-semibold tracking-tight md:text-6xl">
            Turn your old phone into a <span className="text-primary">smart doorbell</span>.
          </h1>
          <p className="mx-auto mt-5 max-w-2xl text-pretty text-muted-foreground md:text-lg">
            HomeDevices pairs any spare phone or tablet with the device you carry every day.
            Get instant ring alerts, a live camera feed, two‑way audio and chat — all from a single link.
          </p>
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <Button asChild size="lg"><Link to={user ? "/dashboard" : "/auth"}>Create a doorbell</Link></Button>
            <Button asChild size="lg" variant="outline"><Link to="/join">I'm the doorbell device</Link></Button>
          </div>
        </section>

        <section className="mt-20 grid gap-5 md:grid-cols-3">
          {[
            { icon: Camera, title: "Live camera feed", body: "Tap the alert to see a real-time view of who's at your door." },
            { icon: MessageSquare, title: "Talk or chat", body: "Two-way voice when you want it. Quick text when you don't." },
            { icon: ShieldCheck, title: "Just a code to pair", body: "No installs. Open the link on any phone, enter the code, you're live." },
          ].map(({ icon: Icon, title, body }) => (
            <div key={title} className="rounded-2xl border bg-card p-6 shadow-sm">
              <div className="grid h-10 w-10 place-items-center rounded-lg bg-accent text-accent-foreground">
                <Icon className="h-5 w-5" />
              </div>
              <h3 className="mt-4 font-semibold">{title}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{body}</p>
            </div>
          ))}
        </section>

        <section className="mt-20 rounded-3xl border bg-card p-8 md:p-12">
          <h2 className="text-2xl font-semibold md:text-3xl">How it works</h2>
          <ol className="mt-6 grid gap-6 md:grid-cols-3">
            {[
              "Create an account and add a doorbell on the device you carry.",
              "Open the access code and enter it on the phone you want to mount.",
              "That device becomes the doorbell — ring, talk and chat in real time.",
            ].map((step, i) => (
              <li key={i} className="rounded-xl bg-background/60 p-5">
                <div className="text-sm font-medium text-primary">Step {i + 1}</div>
                <p className="mt-2 text-sm">{step}</p>
              </li>
            ))}
          </ol>
        </section>
      </main>

      <footer className="border-t py-8 text-center text-xs text-muted-foreground">
        © {new Date().getFullYear()} HomeDevices
      </footer>
    </div>
  );
}
