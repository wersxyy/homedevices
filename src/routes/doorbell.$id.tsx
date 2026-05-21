import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useServerFn } from "@tanstack/react-start";
import { Bell, Maximize2, Mic, MicOff, Send, MessageSquare, BellRing } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { recordRing } from "@/lib/devices.functions";

export const Route = createFileRoute("/doorbell/$id")({
  component: DoorbellPage,
  head: () => ({ meta: [{ title: "Doorbell — HomeDevices" }] }),
});

type ChatMsg = { from: "owner" | "doorbell"; text: string; at: number };

const ICE = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

function DoorbellPage() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const ring = useServerFn(recordRing);

  const [name, setName] = useState<string>("Doorbell");
  const [permError, setPermError] = useState<string | null>(null);
  const [permGranted, setPermGranted] = useState(false);
  const [ringText, setRingText] = useState("");
  const [ringing, setRinging] = useState(false);
  const [viewing, setViewing] = useState(false);
  const [allowed, setAllowed] = useState(false);
  const [ownerOnline, setOwnerOnline] = useState(false);
  const [ownerDnd, setOwnerDnd] = useState(false);
  const [ownerScreenText, setOwnerScreenText] = useState("Press RING for help");

  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [speakingBack, setSpeakingBack] = useState(false);
  const [isFull, setIsFull] = useState(false);

  const previewRef = useRef<HTMLVideoElement | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const wakeLockRef = useRef<{ release: () => Promise<void> } | null>(null);
  const pendingIce = useRef<RTCIceCandidateInit[]>([]);
  const activeRef = useRef<{ ringing: boolean; viewing: boolean }>({ ringing: false, viewing: false });
  const fsContainerRef = useRef<HTMLDivElement | null>(null);

  async function enterFullscreen() {
    setIsFull(true);
    await new Promise((r) => setTimeout(r, 50));
    const el = fsContainerRef.current;
    if (!el) return;
    const anyEl = el as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
    const anyVideo = previewRef.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    try {
      if (el.requestFullscreen) await el.requestFullscreen();
      else if (anyEl.webkitRequestFullscreen) await anyEl.webkitRequestFullscreen();
      else if (anyVideo?.webkitEnterFullscreen) anyVideo.webkitEnterFullscreen();
    } catch { /* unsupported */ }
  }
  async function exitFullscreen() {
    const anyDoc = document as Document & {
      webkitFullscreenElement?: Element | null;
      webkitExitFullscreen?: () => Promise<void> | void;
    };
    try {
      if (document.fullscreenElement && document.exitFullscreen) await document.exitFullscreen();
      else if (anyDoc.webkitFullscreenElement && anyDoc.webkitExitFullscreen) await anyDoc.webkitExitFullscreen();
    } catch { /* noop */ }
    setIsFull(false);
  }

  useEffect(() => {
    function onChange() {
      const anyDoc = document as Document & { webkitFullscreenElement?: Element | null };
      if (!document.fullscreenElement && !anyDoc.webkitFullscreenElement) setIsFull(false);
    }
    document.addEventListener("fullscreenchange", onChange);
    document.addEventListener("webkitfullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      document.removeEventListener("webkitfullscreenchange", onChange);
    };
  }, []);

  // Load device info from sessionStorage
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

  // Request media permission immediately
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: true });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        // Pre-disable audio (only on when "speak back")
        stream.getAudioTracks().forEach((t) => (t.enabled = false));
        localStreamRef.current = stream;
        if (previewRef.current) {
          previewRef.current.srcObject = stream;
          previewRef.current.play().catch(() => {});
        }
        setPermGranted(true);
      } catch (e) {
        setPermError((e as Error).message || "Camera/microphone permission is required");
      }
    })();
    return () => {
      cancelled = true;
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
      localStreamRef.current = null;
    };
  }, []);

  // Attach the local camera stream to the preview element after it mounts.
  // permGranted flips the UI to render the <video>, so this runs *after* the ref exists.
  useEffect(() => {
    if (!permGranted) return;
    const v = previewRef.current;
    const s = localStreamRef.current;
    if (v && s && v.srcObject !== s) {
      v.srcObject = s;
      v.muted = true;
      (v as HTMLVideoElement & { playsInline?: boolean }).playsInline = true;
      v.play().catch(() => {});
    }
  }, [permGranted, isFull]);


  // Channel — connect immediately so the owner sees the doorbell as online,
  // even before camera/mic permission resolves.
  useEffect(() => {

    const ch = supabase.channel(`device-${id}`, { config: { presence: { key: "doorbell" } } });
    channelRef.current = ch;

    ch.on("presence", { event: "sync" }, () => {
      const state = ch.presenceState() as Record<string, Array<{ online?: boolean; dnd?: boolean; screenText?: string }>>;
      const owner = state["owner"]?.[0];
      setOwnerOnline(Boolean(owner));
      setOwnerDnd(Boolean(owner?.dnd));
      setOwnerScreenText(owner?.screenText?.trim() || "Press RING for help");
    });


    ch.on("broadcast", { event: "answer" }, async (msg) => {
      const sdp = msg.payload as RTCSessionDescriptionInit;
      const pc = pcRef.current;
      if (!pc) return;
      try {
        await pc.setRemoteDescription(sdp);
        for (const c of pendingIce.current) {
          try { await pc.addIceCandidate(c); } catch (e) { console.warn(e); }
        }
        pendingIce.current = [];
      } catch (e) { console.warn(e); }
    });

    ch.on("broadcast", { event: "ice" }, async (msg) => {
      const { from, candidate } = msg.payload as { from: string; candidate: RTCIceCandidateInit };
      if (from === "doorbell") return;
      const pc = pcRef.current;
      if (!pc) return;
      if (pc.remoteDescription) {
        try { await pc.addIceCandidate(candidate); } catch (e) { console.warn(e); }
      } else pendingIce.current.push(candidate);
    });

    ch.on("broadcast", { event: "allowed" }, () => {
      setAllowed(true);
    });
    ch.on("broadcast", { event: "done" }, () => {
      endCall();
    });
    ch.on("broadcast", { event: "owner-end" }, () => endCall());
    ch.on("broadcast", { event: "view-request" }, () => {
      // Use ref instead of stale state closure. If a previous call/view
      // is lingering, tear it down before starting a fresh view session.
      if (activeRef.current.ringing) return;
      if (activeRef.current.viewing) {
        try { pcRef.current?.close(); } catch { /* noop */ }
        pcRef.current = null;
      }
      void startViewSession();
    });
    ch.on("broadcast", { event: "chat" }, (msg) => {
      const m = msg.payload as ChatMsg;
      if (m.from === "doorbell") return;
      setChat((prev) => [...prev, m]);
    });

    ch.subscribe(async (status) => {
      if (status === "SUBSCRIBED") await ch.track({ online: true });
    });

    return () => {
      supabase.removeChannel(ch);
      channelRef.current = null;
    };
  }, [id]);

  // Wake lock — keep device awake whenever the doorbell is active
  useEffect(() => {
    if (!permGranted) return;
    let released = false;
    async function acquire() {
      try {
        if ("wakeLock" in navigator) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const lock = await (navigator as any).wakeLock.request("screen");
          if (released) { try { await lock.release(); } catch { /* noop */ } return; }
          wakeLockRef.current = lock;
          lock.addEventListener?.("release", () => { wakeLockRef.current = null; });
        }
      } catch {
        // ignore
      }
    }
    void acquire();
    const onVis = () => { if (document.visibilityState === "visible" && !wakeLockRef.current) void acquire(); };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      released = true;
      document.removeEventListener("visibilitychange", onVis);
      wakeLockRef.current?.release().catch(() => {});
      wakeLockRef.current = null;
    };
  }, [permGranted]);


  async function onRing() {
    if (ownerDnd) {
      toast.error("Do Not Disturb is on. The owner has muted the doorbell.");
      return;
    }
    const stream = localStreamRef.current;
    if (!stream) {
      toast.error("Camera not ready");
      return;
    }
    if (ringing) return;


    setRinging(true);
    setAllowed(false);
    setSpeakingBack(false);
    setChat([]);
    pendingIce.current = [];

    // record server-side
    try { await ring({ data: { deviceId: id } }); } catch (e) { console.warn(e); }

    // PeerConnection
    const pc = new RTCPeerConnection(ICE);
    pcRef.current = pc;

    for (const t of stream.getTracks()) pc.addTrack(t, stream);

    pc.ontrack = (e) => {
      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = e.streams[0];
        remoteAudioRef.current.play().catch(() => {});
      }
    };

    pc.onicecandidate = (e) => {
      if (e.candidate && channelRef.current) {
        channelRef.current.send({
          type: "broadcast",
          event: "ice",
          payload: { from: "doorbell", candidate: e.candidate.toJSON() },
        });
      }
    };

    // Announce + send offer
    channelRef.current?.send({
      type: "broadcast",
      event: "ring",
      payload: { text: ringText.trim() || null, at: Date.now() },
    });
    if (ringText.trim()) {
      const m: ChatMsg = { from: "doorbell", text: ringText.trim(), at: Date.now() };
      channelRef.current?.send({ type: "broadcast", event: "chat", payload: m });
      setChat((prev) => [...prev, m]);
    }

    const offer = await pc.createOffer({ offerToReceiveAudio: true });
    await pc.setLocalDescription(offer);
    channelRef.current?.send({ type: "broadcast", event: "offer", payload: offer });
  }

  async function startViewSession() {
    const stream = localStreamRef.current;
    if (!stream) return;
    setViewing(true);
    setSpeakingBack(false);
    pendingIce.current = [];

    const pc = new RTCPeerConnection(ICE);
    pcRef.current = pc;
    for (const t of stream.getTracks()) pc.addTrack(t, stream);
    pc.ontrack = (e) => {
      if (remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = e.streams[0];
        remoteAudioRef.current.play().catch(() => {});
      }
    };
    pc.onicecandidate = (e) => {
      if (e.candidate && channelRef.current) {
        channelRef.current.send({
          type: "broadcast",
          event: "ice",
          payload: { from: "doorbell", candidate: e.candidate.toJSON() },
        });
      }
    };
    const offer = await pc.createOffer({ offerToReceiveAudio: true });
    await pc.setLocalDescription(offer);
    channelRef.current?.send({ type: "broadcast", event: "offer", payload: offer });
  }

  function endCall() {
    pcRef.current?.close();
    pcRef.current = null;
    setRinging(false);
    setViewing(false);
    setAllowed(false);
    setSpeakingBack(false);
    setRingText("");
    setChat([]);
    setChatInput("");
    pendingIce.current = [];
    // disable mic again
    localStreamRef.current?.getAudioTracks().forEach((t) => (t.enabled = false));
    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
  }

  function toggleSpeakBack() {
    const stream = localStreamRef.current;
    if (!stream) return;
    const next = !speakingBack;
    stream.getAudioTracks().forEach((t) => (t.enabled = next));
    setSpeakingBack(next);
  }

  function sendChat() {
    const text = chatInput.trim();
    if (!text) return;
    const m: ChatMsg = { from: "doorbell", text, at: Date.now() };
    channelRef.current?.send({ type: "broadcast", event: "chat", payload: m });
    setChat((prev) => [...prev, m]);
    setChatInput("");
  }

  if (permError) {
    return (
      <div className="grid min-h-screen place-items-center bg-background px-4">
        <div className="max-w-md rounded-2xl border bg-card p-6 text-center">
          <h1 className="text-lg font-semibold">Permission needed</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            HomeDevices needs access to this device's camera and microphone to act as a doorbell. {permError}
          </p>
          <Button className="mt-4" onClick={() => location.reload()}>Try again</Button>
        </div>
      </div>
    );
  }

  if (!permGranted) {
    return (
      <div className="grid min-h-screen place-items-center bg-background px-4 text-center">
        <div>
          <div className="mx-auto h-10 w-10 animate-pulse rounded-full bg-primary/20" />
          <p className="mt-4 text-sm text-muted-foreground">Requesting camera & microphone…</p>
        </div>
      </div>
    );
  }

  return (
    <div ref={fsContainerRef} className={`min-h-screen ${isFull ? "fixed inset-0 z-50 bg-black" : ""}`} style={isFull ? { minHeight: "100dvh" } : undefined}>
      {!isFull && (
        <header className="mx-auto flex max-w-3xl items-center justify-between px-5 py-5">
          <Link to="/" className="flex items-center gap-2 font-semibold">
            <div className="grid h-8 w-8 place-items-center rounded-lg bg-primary text-primary-foreground">
              <Bell className="h-4 w-4" />
            </div>
            HomeDevices
          </Link>
          <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs ${ownerOnline ? "border-success/40 bg-success/10 text-success" : "border-border bg-muted text-muted-foreground"}`}>
            <span className={`h-2 w-2 rounded-full ${ownerOnline ? "bg-success" : "bg-muted-foreground"}`} />
            {ownerOnline ? "Home connected" : "Waiting for home…"}
          </span>
        </header>
      )}

      <main className={`mx-auto ${isFull ? "h-full" : "max-w-3xl px-5"} pb-10`}>
        <div className={`${isFull ? "h-full" : "rounded-2xl border bg-card p-5 shadow-sm"}`}>
          {!isFull && (
            <div className="flex items-center justify-between gap-3">
              <div>
                <h1 className="text-xl font-semibold">{name}</h1>
                <p className="text-xs text-muted-foreground">Doorbell mode</p>
              </div>
              <Button variant="outline" size="sm" onClick={() => void enterFullscreen()}>
                <Maximize2 className="mr-2 h-4 w-4" /> Fullscreen
              </Button>
            </div>
          )}

          <div className={`${isFull ? "absolute inset-0" : "mt-4 aspect-[3/4] sm:aspect-video"} relative overflow-hidden rounded-xl bg-black`}>
            <video ref={previewRef} className="absolute inset-0 h-full w-full object-cover" autoPlay playsInline muted />
            {allowed && (
              <div className="absolute top-4 left-1/2 -translate-x-1/2 rounded-full bg-success px-4 py-1 text-sm font-medium text-success-foreground">
                Allowed — come in
              </div>
            )}
            {isFull && (
              <button
                onClick={() => void exitFullscreen()}
                className="absolute right-4 top-4 rounded-full bg-black/50 px-3 py-1 text-xs text-white backdrop-blur"
                style={{ top: "max(1rem, env(safe-area-inset-top))" }}
              >
                Exit fullscreen
              </button>
            )}
          </div>

          <audio ref={remoteAudioRef} autoPlay playsInline />

          <div
            className={`${isFull ? "absolute bottom-0 inset-x-0 max-h-[55%] overflow-y-auto p-4 text-white space-y-3 backdrop-blur-md bg-black/30" : "mt-4 space-y-3"}`}
            style={isFull ? { paddingBottom: "max(1rem, env(safe-area-inset-bottom))" } : undefined}
          >
            {!ringing && (
              <>
                <div className={`rounded-lg px-3 py-3 text-center text-lg font-semibold ${isFull ? "bg-white/10 text-white" : "bg-accent/50 text-foreground"}`}>
                  {ownerScreenText}
                </div>
                {ownerDnd && (
                  <div className={`rounded-lg border px-3 py-2 text-center text-sm font-medium ${isFull ? "border-white/30 bg-white/10 text-white" : "border-destructive/40 bg-destructive/10 text-destructive"}`}>
                    Do Not Disturb is on — please come back later.
                  </div>
                )}
                <label className={`block text-xs font-medium ${isFull ? "text-white/80" : "text-muted-foreground"}`}>
                  Message (optional)
                </label>
                <Input
                  value={ringText}
                  onChange={(e) => setRingText(e.target.value)}
                  placeholder="e.g. Package delivery"
                  maxLength={120}
                  disabled={ownerDnd}
                  className={isFull ? "bg-white/10 border-white/20 text-white placeholder:text-white/60" : ""}
                />
                <Button
                  onClick={onRing}
                  disabled={ownerDnd}
                  className="w-full h-20 text-2xl font-bold shadow-lg"
                  size="lg"
                >
                  <BellRing className="mr-3 !h-7 !w-7" />
                  {ownerDnd ? "MUTED" : "RING"}
                </Button>

              </>
            )}

            {ringing && (
              <>
                <div className="rounded-lg bg-primary/10 border border-primary/30 px-3 py-2 text-center text-sm font-medium text-primary">
                  {allowed ? "Allowed — come in" : "Ringing…"}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <Button onClick={toggleSpeakBack} variant={speakingBack ? "default" : "outline"} className={speakingBack ? "" : "text-black"}>
                    {speakingBack ? <Mic className="mr-2 h-4 w-4" /> : <MicOff className="mr-2 h-4 w-4" />}
                    {speakingBack ? "Speaking back…" : "Speak back"}
                  </Button>
                  <Button variant="ghost" className={isFull ? "text-white hover:text-white" : ""} onClick={endCall}>End</Button>
                </div>
                <div className={`max-h-32 overflow-y-auto rounded-lg border ${isFull ? "border-white/20 bg-black/40" : "bg-background"} p-2 text-sm space-y-1`}>
                  {chat.length === 0 ? (
                    <p className={`px-1 text-xs inline-flex items-center gap-1 ${isFull ? "text-white/70" : "text-muted-foreground"}`}>
                      <MessageSquare className="h-3 w-3" /> Messages from inside will appear here.
                    </p>
                  ) : chat.map((m, i) => (
                    <div key={i} className={`flex ${m.from === "doorbell" ? "justify-end" : "justify-start"}`}>
                      <span className={`inline-block max-w-[80%] rounded-lg px-2.5 py-1 ${m.from === "doorbell" ? "bg-primary text-primary-foreground" : isFull ? "bg-white/20" : "bg-muted"}`}>
                        {m.text}
                      </span>
                    </div>
                  ))}
                </div>
                <form onSubmit={(e) => { e.preventDefault(); sendChat(); }} className="flex items-center gap-2">
                  <Input
                    value={chatInput}
                    onChange={(e) => setChatInput(e.target.value)}
                    placeholder="Reply…"
                    className={isFull ? "bg-white/10 border-white/20 text-white placeholder:text-white/60" : ""}
                  />
                  <Button type="submit" size="icon"><Send className="h-4 w-4" /></Button>
                </form>
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
