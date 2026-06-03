import { useEffect, useRef, useState } from "react";

import { Bell, Camera, CameraOff, Mic, MicOff, Radio, PhoneOff, Lock } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";

const ICE = { iceServers: [{ urls: "stun:stun.l.google.com:19302" }] };

type Role = "host" | "paired";

type Props = {
  deviceId: string;
  name: string;
  role: Role;
  /** href the back link points to */
  backHref: string;
};

export default function IntercomRoom({ deviceId, name, role, backHref }: Props) {
  const otherRole: Role = role === "host" ? "paired" : "host";

  const [permError, setPermError] = useState<string | null>(null);
  const [permGranted, setPermGranted] = useState(false);
  const [otherOnline, setOtherOnline] = useState(false);
  const [connected, setConnected] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [micLocked, setMicLocked] = useState(false);
  const [cameraOn, setCameraOn] = useState(true);

  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const pendingIce = useRef<RTCIceCandidateInit[]>([]);
  const otherOnlineRef = useRef(false);
  const negotiatedRef = useRef(false);
  const tapTimesRef = useRef<number[]>([]);

  // ---------- media permission ----------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user" },
          audio: true,
        });
        if (cancelled) { stream.getTracks().forEach((t) => t.stop()); return; }
        // mic off by default
        stream.getAudioTracks().forEach((t) => (t.enabled = false));
        localStreamRef.current = stream;
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
          localVideoRef.current.muted = true;
          localVideoRef.current.playsInline = true;
          void localVideoRef.current.play().catch(() => {});
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

  // re-attach local preview if cameraOn toggles cause re-render
  useEffect(() => {
    const v = localVideoRef.current;
    const s = localStreamRef.current;
    if (v && s && v.srcObject !== s) {
      v.srcObject = s;
      v.muted = true;
      v.playsInline = true;
      void v.play().catch(() => {});
    }
  }, [permGranted]);

  // ---------- realtime channel + WebRTC ----------
  useEffect(() => {
    if (!permGranted) return;

    const ch = supabase.channel(`intercom-${deviceId}`, {
      config: { presence: { key: role } },
    });
    channelRef.current = ch;

    ch.on("presence", { event: "sync" }, () => {
      const state = ch.presenceState() as Record<string, unknown[]>;
      const isOther = Boolean(state[otherRole]);
      otherOnlineRef.current = isOther;
      setOtherOnline(isOther);
      if (!isOther) {
        // peer left — tear down
        closePc();
        setConnected(false);
        negotiatedRef.current = false;
      } else if (role === "host" && !negotiatedRef.current) {
        // host initiates as soon as paired side appears
        void startCall();
      }
    });

    ch.on("broadcast", { event: "offer" }, async (msg) => {
      if (role === "host") return; // host sends offer, paired answers
      await handleOffer(msg.payload as RTCSessionDescriptionInit);
    });

    ch.on("broadcast", { event: "answer" }, async (msg) => {
      if (role !== "host") return;
      const pc = pcRef.current;
      if (!pc) return;
      try {
        await pc.setRemoteDescription(msg.payload as RTCSessionDescriptionInit);
        for (const c of pendingIce.current) {
          try { await pc.addIceCandidate(c); } catch (e) { console.warn(e); }
        }
        pendingIce.current = [];
      } catch (e) { console.warn(e); }
    });

    ch.on("broadcast", { event: "ice" }, async (msg) => {
      const { from, candidate } = msg.payload as { from: Role; candidate: RTCIceCandidateInit };
      if (from === role) return;
      const pc = pcRef.current;
      if (!pc) return;
      if (pc.remoteDescription) {
        try { await pc.addIceCandidate(candidate); } catch (e) { console.warn(e); }
      } else {
        pendingIce.current.push(candidate);
      }
    });

    ch.on("broadcast", { event: "bye" }, () => {
      closePc();
      setConnected(false);
      negotiatedRef.current = false;
    });

    ch.subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        await ch.track({ online: true, role });
      }
    });

    return () => {
      try { ch.send({ type: "broadcast", event: "bye", payload: { from: role } }); } catch { /* noop */ }
      closePc();
      supabase.removeChannel(ch);
      channelRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [permGranted, deviceId, role]);

  function buildPc() {
    const pc = new RTCPeerConnection(ICE);
    pcRef.current = pc;
    const stream = localStreamRef.current;
    if (stream) {
      for (const t of stream.getTracks()) pc.addTrack(t, stream);
    }
    pc.ontrack = (e) => {
      const s = e.streams[0];
      if (e.track.kind === "audio" && remoteAudioRef.current) {
        remoteAudioRef.current.srcObject = s;
        remoteAudioRef.current.muted = false;
        remoteAudioRef.current.volume = 1;
        remoteAudioRef.current.play().catch(() => {});
      }
      if (e.track.kind === "video" && remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = s;
        remoteVideoRef.current.playsInline = true;
        remoteVideoRef.current.play().catch(() => {});
      }
    };
    pc.onicecandidate = (e) => {
      if (e.candidate && channelRef.current) {
        channelRef.current.send({
          type: "broadcast",
          event: "ice",
          payload: { from: role, candidate: e.candidate.toJSON() },
        });
      }
    };
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState;
      if (st === "connected") setConnected(true);
      if (st === "failed" || st === "disconnected" || st === "closed") setConnected(false);
    };
    return pc;
  }

  async function startCall() {
    if (!otherOnlineRef.current) return;
    if (negotiatedRef.current) return;
    negotiatedRef.current = true;
    closePc();
    const pc = buildPc();
    pendingIce.current = [];
    const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
    await pc.setLocalDescription(offer);
    channelRef.current?.send({ type: "broadcast", event: "offer", payload: offer });
  }

  async function handleOffer(sdp: RTCSessionDescriptionInit) {
    negotiatedRef.current = true;
    closePc();
    const pc = buildPc();
    pendingIce.current = [];
    await pc.setRemoteDescription(sdp);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    channelRef.current?.send({ type: "broadcast", event: "answer", payload: answer });
  }

  function closePc() {
    try { pcRef.current?.close(); } catch { /* noop */ }
    pcRef.current = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    if (remoteAudioRef.current) remoteAudioRef.current.srcObject = null;
  }

  // ---------- mic control ----------
  function setMic(on: boolean) {
    const s = localStreamRef.current;
    if (!s) return;
    s.getAudioTracks().forEach((t) => (t.enabled = on));
    setSpeaking(on);
  }

  function onSpeakDown() {
    if (micLocked) return;
    setMic(true);
  }
  function onSpeakUp() {
    // record this tap and check for triple-tap
    const now = Date.now();
    const taps = tapTimesRef.current;
    taps.push(now);
    while (taps.length > 3) taps.shift();

    const tripleTap = taps.length === 3 && now - taps[0] < 800;

    if (tripleTap) {
      tapTimesRef.current = [];
      const nextLocked = !micLocked;
      setMicLocked(nextLocked);
      setMic(nextLocked);
      toast.success(nextLocked ? "Mic locked on" : "Mic unlocked");
      return;
    }

    if (!micLocked) setMic(false);
  }

  function endCall() {
    channelRef.current?.send({ type: "broadcast", event: "bye", payload: { from: role } });
    closePc();
    setConnected(false);
    negotiatedRef.current = false;
    // try to start again if peer still online (host)
    setTimeout(() => { if (role === "host" && otherOnlineRef.current) void startCall(); }, 250);
  }

  function toggleCamera() {
    const s = localStreamRef.current;
    if (!s) return;
    const next = !cameraOn;
    s.getVideoTracks().forEach((t) => (t.enabled = next));
    setCameraOn(next);
  }

  // ---------- render ----------
  if (permError) {
    return (
      <div className="grid min-h-screen place-items-center bg-background px-4">
        <div className="max-w-md rounded-2xl border bg-card p-6 text-center">
          <h1 className="text-lg font-semibold">Permission needed</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            HomeDevices needs access to this device's camera and microphone to use the intercom. {permError}
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
    <div className="min-h-screen flex flex-col">
      <header className="mx-auto flex w-full max-w-5xl items-center justify-between px-5 py-4">
        <Link to={backHref} className="flex items-center gap-2 font-semibold">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-primary text-primary-foreground">
            <Bell className="h-4 w-4" />
          </div>
          HomeDevices
        </Link>
        <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs ${connected ? "border-success/40 bg-success/10 text-success" : otherOnline ? "border-primary/40 bg-primary/10 text-primary" : "border-border bg-muted text-muted-foreground"}`}>
          <span className={`h-2 w-2 rounded-full ${connected ? "bg-success" : otherOnline ? "bg-primary" : "bg-muted-foreground"}`} />
          {connected ? "Connected" : otherOnline ? "Connecting…" : "Waiting for the other side…"}
        </span>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-5 pb-6">
        <div className="rounded-2xl border bg-card p-4 shadow-sm">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <div className="grid h-9 w-9 place-items-center rounded-lg bg-primary/10 text-primary">
                <Radio className="h-4 w-4" />
              </div>
              <div>
                <h1 className="text-lg font-semibold leading-tight">{name}</h1>
                <p className="text-xs text-muted-foreground">Intercom · {role === "host" ? "this device" : "paired device"}</p>
              </div>
            </div>
          </div>

          {/* Video area: remote big, local PIP */}
          <div className="relative mt-4 aspect-video overflow-hidden rounded-xl bg-black">
            <video ref={remoteVideoRef} className="absolute inset-0 h-full w-full object-cover" autoPlay playsInline />
            {!connected && (
              <div className="absolute inset-0 grid place-items-center text-center text-sm text-white/70">
                <div>
                  <Radio className="mx-auto h-8 w-8 opacity-70" />
                  <p className="mt-2">{otherOnline ? "Connecting…" : "Waiting for the other side to come online"}</p>
                </div>
              </div>
            )}
            <div className="absolute bottom-3 right-3 h-24 w-32 overflow-hidden rounded-lg border-2 border-white/30 bg-black shadow-lg sm:h-28 sm:w-40">
              <video ref={localVideoRef} className="h-full w-full object-cover" autoPlay playsInline muted />
              {!cameraOn && (
                <div className="absolute inset-0 grid place-items-center bg-black/80 text-[10px] uppercase tracking-wide text-white/70">
                  Camera off
                </div>
              )}
            </div>
          </div>

          <audio ref={remoteAudioRef} autoPlay playsInline />

          {/* Controls */}
          <div className="mt-4 space-y-3">
            <button
              type="button"
              onPointerDown={onSpeakDown}
              onPointerUp={onSpeakUp}
              onPointerCancel={() => { if (!micLocked) setMic(false); }}
              onPointerLeave={(e) => { if (e.buttons && !micLocked) setMic(false); }}
              onContextMenu={(e) => e.preventDefault()}
              className={`w-full select-none rounded-2xl px-4 py-6 text-xl font-bold shadow-lg transition active:scale-[0.99] ${
                micLocked
                  ? "bg-destructive text-destructive-foreground"
                  : speaking
                  ? "bg-primary text-primary-foreground"
                  : "bg-primary/10 text-primary hover:bg-primary/15"
              }`}
              aria-pressed={speaking}
              style={{ WebkitTouchCallout: "none", WebkitUserSelect: "none" }}
            >
              <span className="inline-flex items-center justify-center gap-2">
                {micLocked ? <Lock className="h-5 w-5" /> : speaking ? <Mic className="h-5 w-5" /> : <MicOff className="h-5 w-5" />}
                {micLocked ? "Mic locked on — triple-tap to stop" : speaking ? "Speaking…" : "Hold to speak"}
              </span>
              <span className="mt-1 block text-xs font-normal opacity-80">
                Triple-tap to keep the mic on
              </span>
            </button>

            <div className="grid grid-cols-2 gap-2">
              <Button variant="outline" onClick={toggleCamera}>
                {cameraOn ? <CameraOff className="mr-2 h-4 w-4" /> : <Camera className="mr-2 h-4 w-4" />}
                {cameraOn ? "Turn camera off" : "Turn camera on"}
              </Button>
              <Button variant="ghost" onClick={endCall} disabled={!connected}>
                <PhoneOff className="mr-2 h-4 w-4" /> Reset call
              </Button>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
