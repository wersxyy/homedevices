import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/use-auth";
import IntercomRoom from "@/components/IntercomRoom";

export const Route = createFileRoute("/intercom-host/$id")({
  component: IntercomHost,
  head: () => ({ meta: [{ title: "Intercom — HomeDevices" }] }),
});

type Device = { id: string; name: string; type: string; access_code: string };

function IntercomHost() {
  const { id } = Route.useParams();
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [device, setDevice] = useState<Device | null>(null);
  const [showCode, setShowCode] = useState(false);

  useEffect(() => {
    if (!loading && !user) navigate({ to: "/auth" });
  }, [user, loading, navigate]);

  useEffect(() => {
    if (!user) return;
    supabase
      .from("devices")
      .select("id,name,type,access_code")
      .eq("id", id)
      .maybeSingle()
      .then(({ data, error }) => {
        if (error) toast.error(error.message);
        else if (!data) { toast.error("Device not found"); navigate({ to: "/dashboard" }); }
        else setDevice(data as Device);
      });
  }, [id, user, navigate]);

  if (!device) {
    return <div className="grid min-h-screen place-items-center text-sm text-muted-foreground">Loading…</div>;
  }

  return (
    <div>
      <IntercomRoom deviceId={device.id} name={device.name} role="host" backHref="/dashboard" />
      <div className="mx-auto max-w-3xl px-5 pb-12">
        <div className="rounded-2xl border bg-card p-4 text-sm">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="font-medium">Pair another device</p>
              <p className="text-xs text-muted-foreground">Open /join on the other phone or tablet and enter this code.</p>
            </div>
            <button
              onClick={() => setShowCode((s) => !s)}
              className="rounded-lg border bg-background px-3 py-2 text-xs font-medium"
            >
              {showCode ? "Hide" : "Show code"}
            </button>
          </div>
          {showCode && (
            <p className="mt-3 rounded-lg bg-accent/50 px-3 py-3 text-center text-2xl font-bold tracking-[0.4em]">
              {device.access_code}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
