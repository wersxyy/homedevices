import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Bell, BellOff, Check, X, Mic, MicOff, Maximize2, Send, MessageSquare, PhoneOff, PictureInPicture2, Music, Upload, RotateCcw, Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/use-auth";
import defaultRingSound from "@/assets/ring-default.mp3";

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
  const dndKey = `homedevices:dnd:${id}`;
  const screenTextKey = `homedevices:screen-text:${id}`;
  const [dnd, setDnd] = useState<boolean>(() => {
    try { return localStorage.getItem(`homedevices:dnd:${id}`) === "1"; } catch { return false; }
  });
  const [doorbellScreenText, setDoorbellScreenText] = useState<string>(() => {
    try { return localStorage.getItem(`homedevices:screen-text:${id}`) || "Press RING for help"; } catch { return "Press RING for help"; }
  });


  // Incoming-call state
  const [ringing, setRinging] = useState(false);
  const [viewing, setViewing] = useState(false);
  const [ringtonePlaying, setRingtonePlaying] = useState(false);
  const [allowed, setAllowed] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [chatInput, setChatInput] = useState("");

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const pipVideoRef = useRef<HTMLVideoElement | null>(null);
  const pipCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const pipRafRef = useRef<number | null>(null);
  const idleCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const idleStreamRef = useRef<MediaStream | null>(null);
  const idleRafRef = useRef<number | null>(null);
  const [pipActive, setPipActive] = useState(false);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const pendingIce = useRef<RTCIceCandidateInit[]>([]);
  const ringAudioRef = useRef<HTMLAudioElement | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const [customSound, setCustomSound] = useState<{ name: string; dataUrl: string } | null>(null);
  const ringOverlayRef = useRef<HTMLDivElement | null>(null);
  const fullScreenRef = useRef<HTMLDivElement | null>(null);
  const fullscreenVideoRef = useRef<HTMLVideoElement | null>(null);
  const allowTimerRef = useRef<number | null>(null);

  // Idle "Waiting for visitor" canvas stream so the <video> always has frames —
  // required so PiP can be opened before anyone rings.
  function ensureIdleStream(): MediaStream | null {
    if (idleStreamRef.current) return idleStreamRef.current;
    try {
      const canvas = idleCanvasRef.current ?? document.createElement("canvas");
      canvas.width = 640; canvas.height = 360;
      idleCanvasRef.current = canvas;
      const ctx = canvas.getContext("2d");
      if (!ctx) return null;
      const draw = () => {
        const t = new Date();
        ctx.fillStyle = "#0b0b0f";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = "#ffffff";
        ctx.font = "600 28px system-ui, -apple-system, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText("Waiting for visitor…", canvas.width / 2, canvas.height / 2 - 8);
        ctx.fillStyle = "#9ca3af";
        ctx.font = "16px system-ui, -apple-system, sans-serif";
        ctx.fillText(device?.name ?? "HomeDevices", canvas.width / 2, canvas.height / 2 + 24);
        ctx.fillStyle = "#6b7280";
        ctx.font = "12px system-ui, -apple-system, sans-serif";
        ctx.fillText(t.toLocaleTimeString(), canvas.width / 2, canvas.height - 18);
        idleRafRef.current = window.setTimeout(() => requestAnimationFrame(draw), 1000) as unknown as number;
      };
      draw();
      const c = canvas as HTMLCanvasElement & { captureStream?: (fps?: number) => MediaStream };
      const stream = c.captureStream?.(15) ?? null;
      idleStreamRef.current = stream;
      return stream;
    } catch { return null; }
  }
  function stopIdleStream() {
    if (idleRafRef.current != null) { clearTimeout(idleRafRef.current); idleRafRef.current = null; }
    idleStreamRef.current?.getTracks().forEach((t) => t.stop());
    idleStreamRef.current = null;
  }
  function attachIdleToVideo() {
    const v = videoRef.current;
    if (!v) return;
    const s = ensureIdleStream();
    if (s && v.srcObject !== s) {
      v.srcObject = s;
      v.muted = true;
      v.playsInline = true;
      void v.play().catch(() => {});
    }
    const fv = fullscreenVideoRef.current;
    if (fv && s && fv.srcObject !== s) {
      fv.srcObject = s;
      fv.muted = true;
      fv.playsInline = true;
      void fv.play().catch(() => {});
    }
  }

  async function requestNativeFullscreen(el: HTMLElement | null) {
    if (!el) return;
    const anyEl = el as HTMLElement & {
      webkitRequestFullscreen?: () => Promise<void> | void;
    };
    try {
      if (el.requestFullscreen) await el.requestFullscreen();
      else if (anyEl.webkitRequestFullscreen) await anyEl.webkitRequestFullscreen();
    } catch { /* user gesture / unsupported */ }
  }
  async function exitNativeFullscreen() {
    const anyDoc = document as Document & {
      webkitFullscreenElement?: Element | null;
      webkitExitFullscreen?: () => Promise<void> | void;
    };
    try {
      if (document.fullscreenElement && document.exitFullscreen) await document.exitFullscreen();
      else if (anyDoc.webkitFullscreenElement && anyDoc.webkitExitFullscreen) await anyDoc.webkitExitFullscreen();
    } catch { /* noop */ }
  }

  const soundKey = `homedevices:ringsound:${id}`;
  useEffect(() => {
    try {
      const raw = localStorage.getItem(soundKey);
      if (raw) setCustomSound(JSON.parse(raw));
    } catch { /* noop */ }
  }, [soundKey]);

  // Unlock audio on the first user gesture so playRing() actually plays
  // (browsers block audio.play() without prior user interaction).
  const audioUnlockedRef = useRef(false);
  useEffect(() => {
    function unlock() {
      if (audioUnlockedRef.current) return;
      try {
        const a = ringAudioRef.current ?? new Audio();
        ringAudioRef.current = a;
        const src = customSound?.dataUrl ?? defaultRingSound;
        if (a.src !== src) a.src = src;
        a.muted = true;
        a.loop = true;
        a.play().then(() => { a.pause(); a.currentTime = 0; a.muted = false; audioUnlockedRef.current = true; })
          .catch(() => { /* will retry on next gesture */ });
      } catch { /* noop */ }
    }
    window.addEventListener("pointerdown", unlock, { once: false });
    window.addEventListener("keydown", unlock, { once: false });
    return () => {
      window.removeEventListener("pointerdown", unlock);
      window.removeEventListener("keydown", unlock);
    };
  }, [customSound?.dataUrl]);

  function playRing() {
    try {
      const src = customSound?.dataUrl ?? defaultRingSound;
      const a = ringAudioRef.current ?? new Audio();
      ringAudioRef.current = a;
      if (a.src !== src) a.src = src;
      a.loop = true;
      a.muted = false;
      a.currentTime = 0;
      setRingtonePlaying(true);
      void a.play().catch((err) => { console.warn("Ringtone blocked:", err); setRingtonePlaying(false); });
    } catch { /* noop */ }
  }

  function stopRing() {
    const a = ringAudioRef.current;
    setRingtonePlaying(false);
    if (!a) return;
    try { a.pause(); a.currentTime = 0; } catch { /* noop */ }
  }

  async function onPickSound(file: File) {
    if (!file.type.startsWith("audio/")) { toast.error("Please choose an audio file"); return; }
    if (file.size > 3 * 1024 * 1024) { toast.error("Max 3 MB"); return; }
    const dataUrl: string = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(r.result as string);
      r.onerror = () => rej(r.error);
      r.readAsDataURL(file);
    });
    const next = { name: file.name, dataUrl };
    setCustomSound(next);
    try { localStorage.setItem(soundKey, JSON.stringify(next)); } catch { /* quota */ }
    toast.success("Custom ring sound saved");
  }
  function resetSound() {
    setCustomSound(null);
    try { localStorage.removeItem(soundKey); } catch { /* noop */ }
  }

  useEffect(() => {
    if (!loading && !user) navigate({ to: "/auth" });
  }, [user, loading, navigate]);

  // Attach the idle placeholder stream once the video is mounted so the user
  // can open Picture-in-Picture even before anyone rings.
  useEffect(() => {
    attachIdleToVideo();
    return () => { stopIdleStream(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Mirror the active stream into the fullscreen video whenever fullscreen opens.
  useEffect(() => {
    if (!fullScreen) return;
    const fv = fullscreenVideoRef.current;
    const v = videoRef.current;
    if (fv && v?.srcObject) {
      fv.srcObject = v.srcObject;
      void fv.play().catch(() => {});
    } else {
      attachIdleToVideo();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullScreen]);

  // Persist owner options + re-broadcast presence when they change
  useEffect(() => {
    try { localStorage.setItem(dndKey, dnd ? "1" : "0"); } catch { /* noop */ }
    const ch = channelRef.current;
    if (ch) void ch.track({ online: true, dnd, screenText: doorbellScreenText });
  }, [dnd, dndKey, doorbellScreenText]);

  useEffect(() => {
    try { localStorage.setItem(screenTextKey, doorbellScreenText); } catch { /* noop */ }
    const ch = channelRef.current;
    if (ch) void ch.track({ online: true, dnd, screenText: doorbellScreenText });
  }, [screenTextKey, doorbellScreenText, dnd]);


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
      playRing();
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
        await ch.track({ online: true, dnd, screenText: doorbellScreenText });
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
    closePc({ reattachIdle: false });
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
      if (e.track.kind === "audio") {
        // Route remote audio to a dedicated <audio> element so "Speak back"
        // is audible even when the video element is muted between calls.
        if (remoteAudioRef.current && stream) {
          remoteAudioRef.current.srcObject = stream;
          remoteAudioRef.current.muted = false;
          remoteAudioRef.current.volume = 1;
          remoteAudioRef.current.play().catch((err) => console.warn("remote audio blocked:", err));
        }
        return;
      }
      if (videoRef.current && stream) {
        videoRef.current.srcObject = stream;
        videoRef.current.play().catch(() => {});
      }
      if (fullscreenVideoRef.current && stream) {
        fullscreenVideoRef.current.srcObject = stream;
        fullscreenVideoRef.current.play().catch(() => {});
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

  function closePc(opts: { reattachIdle?: boolean } = {}) {
    const reattachIdle = opts.reattachIdle ?? true;
    pcRef.current?.getSenders().forEach((s) => { try { s.track?.stop(); } catch { /* noop */ } });
    pcRef.current?.close();
    pcRef.current = null;
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
    // Restore idle placeholder so PiP keeps working between calls.
    if (reattachIdle) attachIdleToVideo();
  }

  function stopPipLoop() {
    if (pipRafRef.current != null) {
      cancelAnimationFrame(pipRafRef.current);
      pipRafRef.current = null;
    }
  }

  async function exitPip() {
    stopPipLoop();
    const sv = videoRef.current as (HTMLVideoElement & {
      webkitPresentationMode?: string;
      webkitSetPresentationMode?: (m: string) => void;
    }) | null;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else if (sv?.webkitPresentationMode === "picture-in-picture" && sv.webkitSetPresentationMode) {
        sv.webkitSetPresentationMode("inline");
      }
    } catch { /* noop */ }
    setPipActive(false);
  }

  async function enterPip() {
    const sv = videoRef.current as (HTMLVideoElement & {
      webkitSupportsPresentationMode?: (m: string) => boolean;
      webkitSetPresentationMode?: (m: string) => void;
      webkitPresentationMode?: string;
      requestPictureInPicture?: () => Promise<PictureInPictureWindow>;
      disablePictureInPicture?: boolean;
    }) | null;
    if (!sv) { toast.error("Video not ready"); return; }
    // Make sure PiP isn't disabled by attribute, and the element is playing.
    sv.disablePictureInPicture = false;
    sv.removeAttribute("disablepictureinpicture");
    // If nothing is streaming yet, attach the idle placeholder so PiP can open.
    if (!sv.srcObject && !sv.src) attachIdleToVideo();
    try { sv.muted = ringing ? false : true; await sv.play(); } catch { /* noop */ }
    if (!sv.srcObject && !sv.src) { toast.error("Waiting for video — try again in a moment"); return; }

    // Safari (iOS / macOS) path
    if (typeof sv.webkitSetPresentationMode === "function") {
      try {
        sv.webkitSetPresentationMode("picture-in-picture");
        setPipActive(true);
        const onChange = () => {
          if (sv.webkitPresentationMode !== "picture-in-picture") {
            setPipActive(false);
            sv.removeEventListener("webkitpresentationmodechanged", onChange);
          }
        };
        sv.addEventListener("webkitpresentationmodechanged", onChange);
        return;
      } catch (e) {
        console.warn("Safari PiP failed:", e);
      }
    }

    // Standard Picture-in-Picture API
    if (typeof sv.requestPictureInPicture === "function") {
      try {
        await sv.requestPictureInPicture();
        setPipActive(true);
        sv.addEventListener("leavepictureinpicture", () => setPipActive(false), { once: true });
        return;
      } catch (e) {
        console.warn("PiP failed:", e);
        toast.error(`Picture-in-Picture failed: ${(e as Error).message || "try again"}`);
        return;
      }
    }

    toast.error("Picture-in-Picture isn't supported in this browser");
  }

  // Auto-enter PiP when the user backgrounds the tab during a call,
  // so the visitor's camera stays visible on iOS / desktop Safari.
  useEffect(() => {
    if (!ringing) return;
    function onVis() {
      if (document.visibilityState === "hidden" && !pipActive) {
        void enterPip();
      }
    }
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ringing, pipActive]);



  function closeCall() {
    if (allowTimerRef.current != null) {
      window.clearTimeout(allowTimerRef.current);
      allowTimerRef.current = null;
    }
    setRinging(false);
    setViewing(false);
    setAllowed(false);
    setSpeaking(false);
    setChat([]);
    setChatInput("");
    stopRing();
    void exitPip();
    void exitNativeFullscreen();
    closePc();
  }

  function startView() {
    if (!doorbellOnline) { toast.error("Doorbell is offline"); return; }
    if (ringing || viewing) return;
    // Clear idle placeholder so "Waiting for visitor…" doesn't show while
    // the WebRTC connection is being established.
    if (videoRef.current) videoRef.current.srcObject = null;
    if (fullscreenVideoRef.current) fullscreenVideoRef.current.srcObject = null;
    setViewing(true);
    setSpeaking(false);
    pendingIce.current = [];
    channelRef.current?.send({ type: "broadcast", event: "view-request", payload: {} });
  }

  function stopView() {
    channelRef.current?.send({ type: "broadcast", event: "owner-end", payload: {} });
    closeCall();
  }

  function toggleSpeak() {
    const stream = localStreamRef.current;
    if (!stream) {
      toast.error("Microphone unavailable");
      return;
    }
    stopRing();
    const next = !speaking;
    stream.getAudioTracks().forEach((t) => (t.enabled = next));
    setSpeaking(next);
  }

  function sendAllow() {
    stopRing();
    setAllowed(true);
    channelRef.current?.send({ type: "broadcast", event: "allowed", payload: {} });
    if (allowTimerRef.current != null) window.clearTimeout(allowTimerRef.current);
    allowTimerRef.current = window.setTimeout(() => {
      channelRef.current?.send({ type: "broadcast", event: "done", payload: {} });
      channelRef.current?.send({ type: "broadcast", event: "owner-end", payload: {} });
      closeCall();
    }, 3500);
  }

  function sendDone() {
    stopRing();
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
      {/* Always-mounted video. Lives at root so PiP works even before anyone
          rings (driven by the idle canvas stream) and the WebRTC stream can
          attach without remounting. When ringing, it fills the screen behind
          the overlay UI; otherwise it sits hidden 1x1 offscreen. */}
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted={!ringing && !viewing}
        className={
          ringing || viewing
            ? "fixed inset-0 z-40 h-full w-full bg-black object-cover"
            : "pointer-events-none fixed bottom-0 right-0 h-px w-px opacity-0"
        }
      />
      <audio ref={remoteAudioRef} autoPlay playsInline />
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
            <Button variant="outline" onClick={() => { setFullScreen(true); setTimeout(() => requestNativeFullscreen(fullScreenRef.current), 50); }}>
              <Maximize2 className="mr-2 h-4 w-4" /> Full screen
            </Button>
            <Button variant="default" className="sm:col-span-2" onClick={startView} disabled={!doorbellOnline || ringing || viewing}>
              <Eye className="mr-2 h-4 w-4" />
              {viewing ? "Viewing camera…" : "View camera"}
            </Button>
            <Button variant="outline" className="sm:col-span-2" onClick={() => (pipActive ? exitPip() : enterPip())}>
              <PictureInPicture2 className="mr-2 h-4 w-4" />
              {pipActive ? "Exit Picture-in-Picture" : "Picture-in-Picture"}
            </Button>
            <Button
              variant={dnd ? "default" : "outline"}
              className={dnd ? "sm:col-span-2 bg-destructive text-destructive-foreground hover:bg-destructive/90" : "sm:col-span-2"}
              onClick={() => setDnd((v) => !v)}
            >
              {dnd ? <BellOff className="mr-2 h-4 w-4" /> : <Bell className="mr-2 h-4 w-4" />}
              {dnd ? "Do not disturb is ON — tap to allow rings" : "Do not disturb"}
            </Button>
          </div>
          <p className="mt-2 text-center text-xs text-muted-foreground">
            {pipActive
              ? "Picture-in-Picture is on — you'll see your doorbell even if you leave this tab."
              : "Tip: Open Picture-in-Picture, then switch tabs — the ring still plays."}
          </p>
          {dnd && (
            <p className="mt-2 text-center text-xs text-muted-foreground">
              The doorbell can't ring while this is on.
            </p>
          )}

          <div className="mt-4 rounded-xl border bg-background/40 p-4">
            <label htmlFor="doorbell-screen-text" className="text-sm font-medium text-foreground">
              Doorbell screen text
            </label>
            <Input
              id="doorbell-screen-text"
              className="mt-2"
              value={doorbellScreenText}
              onChange={(e) => setDoorbellScreenText(e.target.value)}
              placeholder="Press RING for help"
              maxLength={90}
            />
            <p className="mt-2 text-xs text-muted-foreground">
              This appears above the ring button on the doorbell device.
            </p>
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

          <div className="mt-4 rounded-xl border bg-background/40 p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="inline-flex items-center gap-2 text-sm font-medium text-foreground">
                  <Music className="h-4 w-4" /> Ring sound
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Plays only on this device when someone rings. The doorbell won't hear it.
                </p>
                <p className="mt-2 text-xs">
                  Current: <span className="font-medium text-foreground">{customSound ? customSound.name : "Default"}</span>
                </p>
              </div>
              <div className="flex flex-col gap-2">
                <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border px-3 py-1.5 text-xs hover:bg-accent">
                  <Upload className="h-3.5 w-3.5" /> Upload
                  <input
                    type="file"
                    accept="audio/*"
                    className="hidden"
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) void onPickSound(f); e.target.value = ""; }}
                  />
                </label>
                <Button variant="ghost" size="sm" onClick={() => { const a = new Audio(customSound?.dataUrl ?? defaultRingSound); void a.play().catch(() => {}); }}>
                  Preview
                </Button>
                {customSound && (
                  <Button variant="ghost" size="sm" onClick={resetSound}>
                    <RotateCcw className="mr-1 h-3.5 w-3.5" /> Reset
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* Fullscreen view */}
      {fullScreen && (
        <div
          ref={fullScreenRef}
          className="fixed inset-0 z-40 flex flex-col bg-background p-6"
          style={{ minHeight: "100dvh", paddingTop: "max(1.5rem, env(safe-area-inset-top))", paddingBottom: "max(1.5rem, env(safe-area-inset-bottom))" }}
        >
          <div className="flex items-center justify-between">
            <div>
              <p className="text-xs uppercase tracking-wider text-muted-foreground">{device.name}</p>
              <h2 className="text-lg font-semibold">Live camera</h2>
            </div>
            <Button variant="ghost" size="sm" onClick={() => { void exitNativeFullscreen(); setFullScreen(false); }}>Close</Button>
          </div>

          <div className="mt-4 flex-1 overflow-hidden rounded-2xl border bg-black">
            <video
              ref={fullscreenVideoRef}
              autoPlay
              playsInline
              muted={!ringing}
              className="h-full w-full object-cover"
            />
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-wider text-muted-foreground">Last ring</p>
              <p className="mt-1 text-2xl font-semibold">
                {device.last_ring_at ? new Date(device.last_ring_at).toLocaleString() : "Never"}
              </p>
            </div>
            <p className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs ${doorbellOnline ? "border-success/40 bg-success/10 text-success" : "border-border bg-muted text-muted-foreground"}`}>
              <span className={`h-2 w-2 rounded-full ${doorbellOnline ? "bg-success" : "bg-muted-foreground"}`} />
              {doorbellOnline ? "Doorbell connected" : "Doorbell offline"}
            </p>
          </div>
        </div>
      )}

      {/* Ringing overlay */}
      {ringing && (
        <div
          ref={ringOverlayRef}
          className="pointer-events-none fixed inset-0 z-50 flex flex-col"
          style={{ minHeight: "100dvh" }}
        >
          <div className="pointer-events-auto border-b bg-background/90 backdrop-blur px-5 py-4" style={{ paddingTop: "max(1rem, env(safe-area-inset-top))" }}>
            <p className="text-xs uppercase tracking-wider text-muted-foreground">{device.name}</p>
            <h2 className="text-lg font-semibold">Someone is at your door</h2>
          </div>
          <div className="relative flex-1">
            {allowed && (
              <div className="pointer-events-auto absolute top-4 left-1/2 z-10 -translate-x-1/2 rounded-full bg-success px-4 py-1 text-sm font-medium text-success-foreground">
                Allowed
              </div>
            )}
          </div>
          <div className="pointer-events-auto border-t bg-card p-4 space-y-3" style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button variant="secondary" className="text-black" onClick={stopRing} disabled={!ringtonePlaying}>
                <BellOff className="mr-2 h-4 w-4" />
                {ringtonePlaying ? "Stop ringtone" : "Ringtone stopped"}
              </Button>
              <Button onClick={sendAllow} className="bg-success text-black hover:bg-success/90">
                <Check className="mr-2 h-4 w-4" /> Allow
              </Button>
              <Button variant="outline" className="text-black" onClick={sendDone}>
                Done
              </Button>
              <Button variant={speaking ? "default" : "outline"} className={speaking ? "" : "text-black"} onClick={toggleSpeak}>
                {speaking ? <Mic className="mr-2 h-4 w-4" /> : <MicOff className="mr-2 h-4 w-4" />}
                {speaking ? "Speaking…" : "Speak"}
              </Button>
              <Button variant="outline" className="text-black" onClick={() => (pipActive ? exitPip() : enterPip())}>
                <PictureInPicture2 className="mr-2 h-4 w-4" />
                {pipActive ? "Exit PiP" : "Picture-in-Picture"}
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

      {/* Viewing overlay (owner-initiated live view) */}
      {viewing && !ringing && (
        <div className="pointer-events-none fixed inset-0 z-50 flex flex-col" style={{ minHeight: "100dvh" }}>
          <div className="pointer-events-auto border-b bg-background/90 backdrop-blur px-5 py-4" style={{ paddingTop: "max(1rem, env(safe-area-inset-top))" }}>
            <p className="text-xs uppercase tracking-wider text-muted-foreground">{device.name}</p>
            <h2 className="text-lg font-semibold inline-flex items-center gap-2"><Eye className="h-4 w-4" /> Live camera</h2>
          </div>
          <div className="flex-1" />
          <div className="pointer-events-auto border-t bg-card p-4 space-y-3" style={{ paddingBottom: "max(1rem, env(safe-area-inset-bottom))" }}>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button variant={speaking ? "default" : "outline"} className={speaking ? "" : "text-black"} onClick={toggleSpeak}>
                {speaking ? <Mic className="mr-2 h-4 w-4" /> : <MicOff className="mr-2 h-4 w-4" />}
                {speaking ? "Speaking…" : "Speak"}
              </Button>
              <Button variant="outline" className="text-black" onClick={() => (pipActive ? exitPip() : enterPip())}>
                <PictureInPicture2 className="mr-2 h-4 w-4" />
                {pipActive ? "Exit PiP" : "Picture-in-Picture"}
              </Button>
              <Button variant="destructive" onClick={stopView}>
                <PhoneOff className="mr-2 h-4 w-4" /> End
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
