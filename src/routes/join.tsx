import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import { Bell, Monitor } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { joinByCode } from "@/lib/devices.functions";

export const Route = createFileRoute("/join")({
  component: JoinPage,
  head: () => ({ meta: [{ title: "Join a device — HomeDevices" }] }),
});

function isDesktop() {
  if (typeof window === "undefined") return false;
  const ua = navigator.userAgent || "";
  const isMobileUA = /Android|iPhone|iPad|iPod|Mobile|Tablet|Silk/i.test(ua);
  const hasTouch = "ontouchstart" in window || navigator.maxTouchPoints > 0;
  const smallScreen = window.matchMedia("(max-width: 1024px)").matches;
  return !isMobileUA && !hasTouch && !smallScreen;
}

function JoinPage() {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const navigate = useNavigate();
  const join = useServerFn(joinByCode);

  useEffect(() => {
    setBlocked(isDesktop());
  }, []);

  async function onJoin(e: React.FormEvent) {
    e.preventDefault();
    if (blocked) return;
    setBusy(true);
    try {
      const res = await join({ data: { code: code.trim().toUpperCase() } });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      sessionStorage.setItem(`device:${res.device.id}`, JSON.stringify(res.device));
      if (res.device.type === "intercom") {
        navigate({ to: "/intercom/$id", params: { id: res.device.id } });
      } else {
        navigate({ to: "/doorbell/$id", params: { id: res.device.id } });
      }
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen place-items-center bg-background px-4">
      <div className="w-full max-w-md rounded-2xl border bg-card p-8 shadow-sm">
        <Link to="/" className="flex items-center gap-2 font-semibold">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-primary text-primary-foreground">
            <Bell className="h-4 w-4" />
          </div>
          HomeDevices
        </Link>
        <h1 className="mt-6 text-2xl font-semibold">Pair this device</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Turn any device into a smart home device. Enter the access code shown on your account.
        </p>

        {blocked ? (
          <div className="mt-6 rounded-xl border bg-destructive/10 p-4 text-sm text-destructive">
            <div className="flex items-center gap-2 font-medium"><Monitor className="h-4 w-4" /> Desktop not supported</div>
            <p className="mt-1 text-destructive/80">Doorbell devices must be a phone or tablet. Open this page on a mobile device to continue.</p>
          </div>
        ) : (
          <form onSubmit={onJoin} className="mt-6 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="code">Access code</Label>
              <Input
                id="code"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="ABC123"
                className="text-center text-2xl tracking-[0.4em] uppercase"
                maxLength={8}
                autoFocus
                required
              />
            </div>
            <Button type="submit" className="w-full" disabled={busy}>
              {busy ? "Joining…" : "Join"}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
