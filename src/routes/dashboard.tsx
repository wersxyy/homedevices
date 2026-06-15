import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { Bell, Plus, LogOut, DoorOpen, Radio, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogTrigger,
} from "@/components/ui/dialog";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/use-auth";

export const Route = createFileRoute("/dashboard")({
  component: Dashboard,
  head: () => ({ meta: [{ title: "Your devices — HomeDevices" }] }),
});

type Device = {
  id: string;
  name: string;
  type: string;
  access_code: string;
  last_ring_at: string | null;
};

function genCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
}

function typeLabel(type: string) {
  if (type === "intercom") return "Intercom";
  if (type === "assistant") return "Voice Assistant";
  return "Doorbell Camera";
}

function Dashboard() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [deviceType, setDeviceType] = useState<"doorbell" | "intercom">("doorbell");
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    if (!loading && !user) navigate({ to: "/auth" });
  }, [user, loading, navigate]);

  async function load() {
    const { data, error } = await supabase
      .from("devices")
      .select("id,name,type,access_code,last_ring_at")
      .order("created_at", { ascending: false });
    if (error) return toast.error(error.message);
    setDevices(data ?? []);
  }

  useEffect(() => {
    if (user) load();
  }, [user]);

  async function createDevice(e: React.FormEvent) {
    e.preventDefault();
    if (!user) return;
    setCreating(true);
    try {
      const { error } = await supabase.from("devices").insert({
        user_id: user.id,
        name: name.trim() || (deviceType === "intercom" ? "Intercom" : "Doorbell"),
        type: deviceType,
        access_code: genCode(),
      });
      if (error) throw error;
      toast.success("Device added");
      setOpen(false);
      setName("");
      setDeviceType("doorbell");
      load();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setCreating(false);
    }
  }

  async function signOut() {
    await supabase.auth.signOut();
    navigate({ to: "/" });
  }

  return (
    <div className="min-h-screen">
      <header className="mx-auto flex max-w-5xl items-center justify-between px-5 py-5">
        <Link to="/" className="flex items-center gap-2 font-semibold">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-primary text-primary-foreground">
            <Bell className="h-4 w-4" />
          </div>
          HomeDevices
        </Link>
        <Button variant="ghost" size="sm" onClick={signOut}>
          <LogOut className="mr-2 h-4 w-4" /> Sign out
        </Button>
      </header>

      <main className="mx-auto max-w-5xl px-5 pb-24">
        <div className="flex items-end justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold md:text-3xl">Your devices</h1>
            <p className="text-sm text-muted-foreground">Turn any device into a smart home device — add one and pair it with a phone or tablet.</p>
          </div>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
              <Button><Plus className="mr-2 h-4 w-4" /> Add device</Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>New smart device</DialogTitle>
              </DialogHeader>
              <form onSubmit={createDevice} className="space-y-4">
                <div className="space-y-2">
                  <Label>Type</Label>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setDeviceType("doorbell")}
                      className={`flex items-center gap-2 rounded-lg border px-3 py-3 text-sm text-left transition ${deviceType === "doorbell" ? "border-primary bg-primary/10 text-foreground" : "border-border bg-accent/30 text-muted-foreground hover:text-foreground"}`}
                    >
                      <DoorOpen className="h-4 w-4 shrink-0" />
                      <div>
                        <div className="font-medium">Doorbell Camera</div>
                        <div className="text-xs text-muted-foreground">Ring, see, speak.</div>
                      </div>
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeviceType("intercom")}
                      className={`flex items-center gap-2 rounded-lg border px-3 py-3 text-sm text-left transition ${deviceType === "intercom" ? "border-primary bg-primary/10 text-foreground" : "border-border bg-accent/30 text-muted-foreground hover:text-foreground"}`}
                    >
                      <Radio className="h-4 w-4 shrink-0" />
                      <div>
                        <div className="font-medium">Intercom</div>
                        <div className="text-xs text-muted-foreground">Room-to-room talk.</div>
                      </div>
                    </button>
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="name">Name</Label>
                  <Input id="name" placeholder={deviceType === "intercom" ? "Kitchen" : "Main Entrance"} value={name} onChange={(e) => setName(e.target.value)} required />
                </div>
                <DialogFooter>
                  <Button type="submit" disabled={creating}>
                    {creating ? "Creating…" : "Create"}
                  </Button>
                </DialogFooter>
              </form>
            </DialogContent>
          </Dialog>
        </div>

        <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {devices === null && <p className="text-sm text-muted-foreground">Loading…</p>}
          {devices?.length === 0 && (
            <div className="col-span-full rounded-2xl border border-dashed bg-card/50 p-10 text-center">
              <DoorOpen className="mx-auto h-8 w-8 text-muted-foreground" />
              <p className="mt-3 text-sm text-muted-foreground">No devices yet. Tap "Add device" to begin.</p>
            </div>
          )}
          {devices?.map((d) => {
            const isIntercom = d.type === "intercom";
            const Icon = isIntercom ? Radio : DoorOpen;
            const to = isIntercom ? "/intercom-host/$id" : "/device/$id";
            return (
              <Link
                key={d.id}
                to={to}
                params={{ id: d.id }}
                className="group rounded-2xl border bg-card p-5 shadow-sm transition hover:border-primary/60 hover:shadow-md"
              >
                <div className="flex items-center gap-3">
                  <div className="grid h-10 w-10 place-items-center rounded-lg bg-primary/10 text-primary">
                    <Icon className="h-5 w-5" />
                  </div>
                  <div>
                    <h3 className="font-semibold">{d.name}</h3>
                    <p className="text-xs text-muted-foreground">{typeLabel(d.type)}</p>
                  </div>
                </div>
                <p className="mt-4 text-xs text-muted-foreground">
                  {isIntercom
                    ? "Tap to open this intercom."
                    : d.last_ring_at ? `Last ring: ${new Date(d.last_ring_at).toLocaleString()}` : "No rings yet"}
                </p>
              </Link>
            );
          })}
        </div>
      </main>
    </div>
  );
}
