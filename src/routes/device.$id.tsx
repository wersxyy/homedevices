import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Bell, Check, X, Mic, MicOff, Maximize2, Send, MessageSquare, PhoneOff, PictureInPicture2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/use-auth";

export const Route = createFileRoute("/device/$id")({
  component: DevicePage,
  head: () => ({ meta: [{ title: "Device — HomeDevices" }] }),
});

type Device = {
  id: string;
  name: string;
  access_code: string;
  last_ring_at: string | null;
};

type ChatMsg = { from: "owner" | "doorbell"; text: string; at: number };

const ICE = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

function DevicePage() {
  const { id } = Route.useParams();
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [device, setDevice] = useState<Device | null>(null);
  const [doorbellOnline, setDoorbellOnline] = useState(false);
  const [showCode, setShowCode] = useState(false);
  const [fullScreen, setFullScreen] = useState(false);

  // Incoming-call state
  const [ringing, setRinging] = useState(false);
  const [allowed, setAllowed] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [chatInput, setChatInput] = useState("");

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const pendingIce = useRef<RTCIceCandidateInit[]>([]);

  useEffect(() => {
    if (!loading && !user) navigate({ to: "/auth" });
  }, [user, loading, navigate]);

  // Load device
  useEffect(() => {
    if (!user) return;
    supabase.from("devices").select("id,name,access_code,last_ring_at").eq("id", id).maybeSingle()
      .then(({ data, error }) => {
        if (error) toast.error(error.message);
        else if (!data) { toast.error("Device not found"); navigate({ to: "/dashboard" }); }
        else setDevice(data as Device);
      });
  }, [id, user, navigate]);

  // Channel setup
  useEffect(() => {
    if (!device || !user) return;
    const ch = supabase.channel(`device-${device.id}`, {
      config: { presence: { key: "owner" } },
    });
    channelRef.current = ch;

    ch.on("presence", { event: "sync" }, () => {
      const state = ch.presenceState() as Record<string, unknown[]>;
      setDoorbellOnline(Boolean(state["doorbell"]));
    });

    ch.on("broadcast", { event: "ring" }, () => {
      setRinging(true);
      setAllowed(false);
      setSpeaking(false);
      setChat([]);
      pendingIce.current = [];
      // refresh last_ring_at
      supabase.from("devices").select("last_ring_at").eq("id", device.id).maybeSingle()
        .then(({ data }) => data && setDevice((d) => d ? { ...d, last_ring_at: data.last_ring_at } : d));
    });

    ch.on("broadcast", { event: "offer" }, async (msg) => {
      const sdp = msg.payload as RTCSessionDescriptionInit;
      await handleOffer(sdp);
    });

    ch.on("broadcast", { event: "ice" }, async (msg) => {
      const { from, candidate } = msg.payload as { from: string; candidate: RTCIceCandidateInit };
      if (from === "owner") return;
      const pc = pcRef.current;
      if (!pc) return;
      if (pc.remoteDescription) {
        try { await pc.addIceCandidate(candidate); } catch (e) { console.warn(e); }
      } else {
        pendingIce.current.push(candidate);
      }
    });

    ch.on("broadcast", { event: "chat" }, (msg) => {
      const m = msg.payload as ChatMsg;
      if (m.from === "owner") return; // we sent it
      setChat((prev) => [...prev, m]);
    });

    ch.on("broadcast", { event: "doorbell-end" }, () => {
      closeCall();
    });

    ch.subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        await ch.track({ online: true });
      }
    });

    return () => {
      closeCall();
      supabase.removeChannel(ch);
      channelRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device?.id, user?.id]);

  async function handleOffer(sdp: RTCSessionDescriptionInit) {
    closePc();
    const pc = new RTCPeerConnection(ICE);
    pcRef.current = pc;

    // Pre-add our mic (muted)
    let local: MediaStream | null = null;
    try {
      local = await navigator.mediaDevices.getUserMedia({ audio: true });
      localStreamRef.current = local;
      for (const t of local.getAudioTracks()) {
        t.enabled = false;
        pc.addTrack(t, local);
      }
    } catch {
      // mic optional
    }

    pc.ontrack = (e) => {
      const stream = e.streams[0];
      if (videoRef.current && stream) {
        videoRef.current.srcObject = stream;
        videoRef.current.play().catch(() => {});
      }
    };

    pc.onicecandidate = (e) => {
      if (e.candidate && channelRef.current) {
        channelRef.current.send({
          type: "broadcast",
          event: "ice",
          payload: { from: "owner", candidate: e.candidate.toJSON() },
        });
      }
    };

    await pc.setRemoteDescription(sdp);
    for (const c of pendingIce.current) {
      try { await pc.addIceCandidate(c); } catch (e) { console.warn(e); }
    }
    pendingIce.current = [];

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    channelRef.current?.send({ type: "broadcast", event: "answer", payload: answer });
  }

  function closePc() {
    pcRef.current?.getSenders().forEach((s) => { try { s.track?.stop(); } catch { /* noop */ } });
    pcRef.current?.close();
    pcRef.current = null;
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }

  function closeCall() {
    setRinging(false);
    setAllowed(false);
    setSpeaking(false);
    closePc();
  }

  function toggleSpeak() {
    const stream = localStreamRef.current;
    if (!stream) {
      toast.error("Microphone unavailable");
      return;
    }
    const next = !speaking;
    stream.getAudioTracks().forEach((t) => (t.enabled = next));
    setSpeaking(next);
  }

  function sendAllow() {
    channelRef.current?.send({ type: "broadcast", event: "allowed", payload: {} });
    setAllowed(true);
  }

  function sendDone() {
    channelRef.current?.send({ type: "broadcast", event: "done", payload: {} });
    channelRef.current?.send({ type: "broadcast", event: "owner-end", payload: {} });
    closeCall();
  }

  function sendChat() {
    const text = chatInput.trim();
    if (!text) return;
    const msg: ChatMsg = { from: "owner", text, at: Date.now() };
    channelRef.current?.send({ type: "broadcast", event: "chat", payload: msg });
    setChat((prev) => [...prev, msg]);
    setChatInput("");
  }

  if (!device) {
    return <div className="grid min-h-screen place-items-center text-sm text-muted-foreground">Loading…</div>;
  }

  return (
    <div className="min-h-screen">
      <header className="mx-auto flex max-w-5xl items-center justify-between px-5 py-5">
        <Link to="/dashboard" className="flex items-center gap-2 font-semibold">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-primary text-primary-foreground">
            <Bell className="h-4 w-4" />
          </div>
          HomeDevices
        </Link>
        <Link to="/dashboard" className="text-sm text-muted-foreground hover:text-foreground">← Devices</Link>
      </header>

      <main className="mx-auto max-w-3xl px-5 pb-24">
        <div className="rounded-2xl border bg-card p-6 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h1 className="text-2xl font-semibold">{device.name}</h1>
              <p className="text-xs text-muted-foreground">Doorbell Camera</p>
            </div>
            <div className="flex items-center gap-2">
              <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs ${doorbellOnline ? "border-success/40 bg-success/10 text-success" : "border-border bg-muted text-muted-foreground"}`}>
                <span className={`h-2 w-2 rounded-full ${doorbellOnline ? "bg-success" : "bg-muted-foreground"}`} />
                {doorbellOnline ? "Doorbell connected" : "Doorbell offline"}
              </span>
            </div>
          </div>

          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            <Button variant="outline" onClick={() => setShowCode((s) => !s)}>
              {showCode ? "Hide code" : "Access Code"}
            </Button>
            <Button variant="outline" onClick={() => setFullScreen(true)}>
              <Maximize2 className="mr-2 h-4 w-4" /> Full screen
            </Button>
          </div>

          {showCode && (
            <div className="mt-4 rounded-xl border bg-accent/40 p-5 text-center">
              <p className="text-xs uppercase tracking-wider text-muted-foreground">Access code</p>
              <p className="mt-1 select-all font-mono text-3xl tracking-[0.4em]">{device.access_code}</p>
              <p className="mt-2 text-xs text-muted-foreground">Open HomeDevices on your phone or tablet and tap “Join”.</p>
            </div>
          )}

          <div className="mt-6 rounded-xl border bg-background/40 p-4 text-sm text-muted-foreground">
            <p className="font-medium text-foreground">Last ring</p>
            <p className="mt-1">{device.last_ring_at ? new Date(device.last_ring_at).toLocaleString() : "Never"}</p>
          </div>
        </div>
      </main>

      {/* Fullscreen view */}
      {fullScreen && (
        <div className="fixed inset-0 z-40 flex flex-col bg-background p-6">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">{device.name}</h2>
            <Button variant="ghost" size="sm" onClick={() => setFullScreen(false)}>Close</Button>
          </div>
          <div className="mt-10 flex-1 grid place-items-center">
            <div className="text-center">
              <p className="text-sm uppercase tracking-wider text-muted-foreground">Last ring</p>
              <p className="mt-3 text-4xl font-semibold">
                {device.last_ring_at ? new Date(device.last_ring_at).toLocaleString() : "Never"}
              </p>
              <p className={`mt-6 inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs ${doorbellOnline ? "border-success/40 bg-success/10 text-success" : "border-border bg-muted text-muted-foreground"}`}>
                <span className={`h-2 w-2 rounded-full ${doorbellOnline ? "bg-success" : "bg-muted-foreground"}`} />
                {doorbellOnline ? "Doorbell connected" : "Doorbell offline"}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Ringing overlay */}
      {ringing && (
        <div className="fixed inset-0 z-50 flex flex-col bg-background/95 backdrop-blur">
          <div className="border-b px-5 py-4">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">{device.name}</p>
            <h2 className="text-lg font-semibold">Someone is at your door</h2>
          </div>
          <div className="relative flex-1 bg-black">
            <video ref={videoRef} className="absolute inset-0 h-full w-full object-cover" autoPlay playsInline />
            {allowed && (
              <div className="absolute top-4 left-1/2 -translate-x-1/2 rounded-full bg-success px-4 py-1 text-sm font-medium text-success-foreground">
                Allowed
              </div>
            )}
          </div>
          <div className="border-t bg-card p-4 space-y-3">
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button onClick={sendAllow} className="bg-success text-success-foreground hover:bg-success/90">
                <Check className="mr-2 h-4 w-4" /> Allow
              </Button>
              <Button variant="outline" onClick={sendDone}>
                Done
              </Button>
              <Button variant={speaking ? "default" : "outline"} onClick={toggleSpeak}>
                {speaking ? <Mic className="mr-2 h-4 w-4" /> : <MicOff className="mr-2 h-4 w-4" />}
                {speaking ? "Speaking…" : "Speak"}
              </Button>
              <Button variant="destructive" onClick={sendDone}>
                <PhoneOff className="mr-2 h-4 w-4" /> End
              </Button>
            </div>
            <div className="max-h-32 overflow-y-auto rounded-lg border bg-background p-2 text-sm space-y-1">
              {chat.length === 0 ? (
                <p className="px-1 text-xs text-muted-foreground inline-flex items-center gap-1">
                  <MessageSquare className="h-3 w-3" /> Chat with the visitor instead of talking.
                </p>
              ) : chat.map((m, i) => (
                <div key={i} className={`flex ${m.from === "owner" ? "justify-end" : "justify-start"}`}>
                  <span className={`inline-block max-w-[80%] rounded-lg px-2.5 py-1 ${m.from === "owner" ? "bg-primary text-primary-foreground" : "bg-muted"}`}>
                    {m.text}
                  </span>
                </div>
              ))}
            </div>
            <form onSubmit={(e) => { e.preventDefault(); sendChat(); }} className="flex items-center gap-2">
              <Input value={chatInput} onChange={(e) => setChatInput(e.target.value)} placeholder="Type a message…" />
              <Button type="submit" size="icon"><Send className="h-4 w-4" /></Button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
