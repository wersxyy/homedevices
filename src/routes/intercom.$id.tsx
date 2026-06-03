import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import IntercomRoom from "@/components/IntercomRoom";

export const Route = createFileRoute("/intercom/$id")({
  component: IntercomPaired,
  head: () => ({ meta: [{ title: "Intercom — HomeDevices" }] }),
});

function IntercomPaired() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const [name, setName] = useState<string>("Intercom");

  useEffect(() => {
    const raw = sessionStorage.getItem(`device:${id}`);
    if (!raw) {
      toast.error("Please rejoin with your access code");
      navigate({ to: "/join" });
      return;
    }
    try {
      const d = JSON.parse(raw) as { name: string };
      setName(d.name);
    } catch {
      navigate({ to: "/join" });
    }
  }, [id, navigate]);

  return <IntercomRoom deviceId={id} name={name} role="paired" backHref="/join" />;
}
