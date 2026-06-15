import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Maximize2, Minimize2, Mic, MicOff, Loader2, Cloud, CloudRain, Sun, CloudSnow, Clock, Timer, ListChecks, Send, Volume2, VolumeX } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/use-auth";
import { askAssistant, synthesizeSpeech, type AssistantReply, type AssistantWidget } from "@/lib/assistant.functions";

export const Route = createFileRoute("/assistant/$id")({
  component: AssistantPage,
  head: () => ({ meta: [{ title: "Voice Assistant — HomeDevices" }] }),
});

type Device = { id: string; name: string; type: string; user_id: string };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const SR: any = typeof window !== "undefined" ? (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition : null;

function AssistantPage() {
  const { id } = Route.useParams();
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [device, setDevice] = useState<Device | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [listening, setListening] = useState(false);
  const [awake, setAwake] = useState(false);
  const [transcript, setTranscript] = useState("");
  const [reply, setReply] = useState<AssistantReply | null>(null);
  const [thinking, setThinking] = useState(false);
  const [supported, setSupported] = useState(true);
  const [input, setInput] = useState("");
  const [muted, setMuted] = useState(false);
  const mutedRef = useRef(false);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const recogRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const awakeRef = useRef(false);
  const nameRef = useRef("");
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    if (!loading && !user) navigate({ to: "/auth" });
  }, [user, loading, navigate]);

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase
        .from("devices")
        .select("id,name,type,user_id")
        .eq("id", id)
        .maybeSingle();
      if (error) return toast.error(error.message);
      if (!data) return;
      setDevice(data as Device);
      nameRef.current = (data as Device).name.toLowerCase();
    })();
  }, [id]);

  useEffect(() => {
    if (!SR) setSupported(false);
  }, []);

  const scheduleClear = useCallback(() => {
    if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
    clearTimerRef.current = setTimeout(() => {
      setReply(null);
      setTranscript("");
      setAwake(false);
      awakeRef.current = false;
    }, 10000);
  }, []);

  const speak = useCallback(async (text: string) => {
    if (mutedRef.current) return;
    // Try OpenAI TTS first
    try {
      const { audio, mime } = await synthesizeSpeech({ data: { text } });
      if (audioRef.current) {
        try { audioRef.current.pause(); } catch { /* noop */ }
      }
      const el = new Audio(`data:${mime};base64,${audio}`);
      audioRef.current = el;
      await el.play();
      return;
    } catch {
      // Fallback to browser TTS
      if (typeof window === "undefined" || !window.speechSynthesis) return;
      try {
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.rate = 1.02;
        window.speechSynthesis.speak(u);
      } catch { /* noop */ }
    }
  }, []);

  const handleQuery = useCallback(
    async (query: string) => {
      if (!device) return;
      setThinking(true);
      setTranscript(query);
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
      try {
        const res = await askAssistant({ data: { assistantName: device.name, prompt: query } });
        setReply(res);
        speak(res.text);
        scheduleClear();
      } catch (err) {
        const msg = (err as Error).message;
        toast.error(msg);
        setReply({ text: msg, widget: { type: "none", data: {} } });
        scheduleClear();
      } finally {
        setThinking(false);
      }
    },
    [device, scheduleClear, speak],
  );

  // Continuous recognition loop
  useEffect(() => {
    if (!device || !SR) return;
    const recog = new SR();
    recog.continuous = true;
    recog.interimResults = true;
    recog.lang = "en-US";
    recogRef.current = recog;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    recog.onresult = (event: any) => {
      let interim = "";
      let finalText = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const r = event.results[i];
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      const heard = (finalText || interim).toLowerCase().trim();
      if (!heard) return;

      if (!awakeRef.current) {
        const name = nameRef.current;
        const idx = heard.lastIndexOf(name);
        if (idx !== -1) {
          const after = heard.slice(idx + name.length).replace(/^[\s,.!?]+/, "").trim();
          if (finalText && after) {
            awakeRef.current = true;
            setAwake(true);
            setTranscript(after);
            handleQuery(after);
          } else if (finalText) {
            awakeRef.current = true;
            setAwake(true);
            setTranscript("");
          }
        }
      } else {
        setTranscript(heard);
        if (finalText.trim()) {
          handleQuery(finalText.trim());
        }
      }
    };

    recog.onstart = () => setListening(true);
    recog.onend = () => {
      setListening(false);
      if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
      restartTimerRef.current = setTimeout(() => {
        try { recog.start(); } catch { /* noop */ }
      }, 250);
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    recog.onerror = (e: any) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        toast.error("Microphone access denied");
        setSupported(false);
      }
    };

    try { recog.start(); } catch { /* noop */ }

    return () => {
      if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
      try {
        recog.onend = null;
        recog.stop();
      } catch { /* noop */ }
    };
  }, [device, handleQuery]);

  useEffect(() => {
    return () => {
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
      if (typeof window !== "undefined" && window.speechSynthesis) window.speechSynthesis.cancel();
      if (audioRef.current) { try { audioRef.current.pause(); } catch { /* noop */ } }
    };
  }, []);

  async function toggleFullscreen() {
    const el = containerRef.current;
    if (!el) return;
    if (!document.fullscreenElement) {
      await el.requestFullscreen?.();
      setFullscreen(true);
    } else {
      await document.exitFullscreen?.();
      setFullscreen(false);
    }
  }

  useEffect(() => {
    const onFs = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "F11") {
        e.preventDefault();
        toggleFullscreen();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("fullscreenchange", onFs);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  function submitTyped(e: React.FormEvent) {
    e.preventDefault();
    const q = input.trim();
    if (!q || thinking) return;
    setInput("");
    awakeRef.current = true;
    setAwake(true);
    handleQuery(q);
  }

  function toggleMute() {
    const next = !muted;
    setMuted(next);
    mutedRef.current = next;
    if (next) {
      if (audioRef.current) { try { audioRef.current.pause(); } catch { /* noop */ } }
      if (typeof window !== "undefined" && window.speechSynthesis) window.speechSynthesis.cancel();
    }
  }

  if (!device) {
    return <div className="grid min-h-screen place-items-center bg-zinc-950 text-zinc-400">Loading…</div>;
  }

  return (
    <div
      ref={containerRef}
      className="relative min-h-screen overflow-hidden bg-zinc-950 text-zinc-100"
    >
      {/* Ambient background */}
      <div className="pointer-events-none absolute inset-0 overflow-hidden">
        <div className={`absolute left-1/2 top-1/3 h-[600px] w-[600px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-violet-600/20 blur-[120px] transition-all duration-1000 ${awake || thinking ? "opacity-100 scale-110" : "opacity-60 scale-100"}`} />
        <div className="absolute right-0 top-0 h-[400px] w-[400px] rounded-full bg-indigo-600/10 blur-[120px]" />
        <div className="absolute bottom-0 left-0 h-[400px] w-[400px] rounded-full bg-fuchsia-600/10 blur-[120px]" />
      </div>

      {/* Header */}
      <header className="absolute left-0 right-0 top-0 z-20 flex items-center justify-between px-5 py-4">
        {!fullscreen ? (
          <Link to="/dashboard" className="inline-flex items-center text-sm text-zinc-400 transition hover:text-zinc-100">
            <ArrowLeft className="mr-1 h-4 w-4" /> Back
          </Link>
        ) : <span />}
        <div className="ml-auto flex items-center gap-2">
          <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium backdrop-blur ${listening ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" : "border-zinc-800 bg-zinc-900/60 text-zinc-400"}`}>
            {listening ? <Mic className="h-3 w-3" /> : <MicOff className="h-3 w-3" />}
            {listening ? "Listening" : "Off"}
          </span>
          <Button variant="ghost" size="sm" onClick={toggleMute} className="text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100">
            {muted ? <VolumeX className="h-4 w-4" /> : <Volume2 className="h-4 w-4" />}
          </Button>
          <Button variant="ghost" size="sm" onClick={toggleFullscreen} className="text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100">
            {fullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </Button>
        </div>
      </header>

      <main className="relative z-10 mx-auto flex min-h-screen max-w-2xl flex-col items-center justify-center px-6 pb-32 pt-20">
        {!supported && (
          <div className="mb-6 rounded-xl border border-red-500/30 bg-red-500/10 p-4 text-sm text-red-200">
            Speech recognition isn't available in this browser. You can still type below.
          </div>
        )}

        {/* Orb */}
        <div className="relative mb-10">
          <div className={`absolute inset-0 rounded-full bg-gradient-to-br from-violet-500 via-fuchsia-500 to-indigo-600 blur-3xl transition-all duration-700 ${awake || thinking ? "opacity-80 scale-125" : "opacity-40 scale-100"}`} />
          <div className={`relative grid h-44 w-44 place-items-center rounded-full bg-gradient-to-br from-violet-500 via-fuchsia-500 to-indigo-600 shadow-[0_0_60px_-10px_rgba(168,85,247,0.6)] transition-all duration-500 ${awake || thinking ? "scale-110" : "scale-100"}`}>
            <div className="absolute inset-1 rounded-full bg-zinc-950/40 backdrop-blur" />
            {thinking ? (
              <Loader2 className="relative h-14 w-14 animate-spin text-white" />
            ) : (
              <Mic className={`relative h-14 w-14 text-white transition-transform ${awake ? "scale-110" : ""}`} />
            )}
          </div>
        </div>

        <h1 className="text-4xl font-semibold tracking-tight text-white">{device.name}</h1>
        <p className="mt-2 text-sm text-zinc-400">
          {thinking
            ? "Thinking…"
            : awake
              ? "I'm listening…"
              : `Say "${device.name}, …" or type below`}
        </p>

        {transcript && (
          <p className="mt-6 max-w-xl text-center text-lg italic text-zinc-300">"{transcript}"</p>
        )}

        {reply && (
          <div className="mt-8 w-full max-w-xl space-y-4 animate-in fade-in slide-in-from-bottom-4">
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-5 text-base text-zinc-100 shadow-xl backdrop-blur-xl">
              {reply.text}
            </div>
            {reply.widget && reply.widget.type !== "none" && <WidgetView widget={reply.widget} />}
          </div>
        )}
      </main>

      {/* Typing input */}
      <form
        onSubmit={submitTyped}
        className="fixed inset-x-0 bottom-0 z-20 mx-auto w-full max-w-2xl px-4 pb-6"
      >
        <div className="flex items-center gap-2 rounded-2xl border border-zinc-800 bg-zinc-900/80 p-2 shadow-2xl backdrop-blur-xl">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={`Ask ${device.name} anything…`}
            className="flex-1 bg-transparent px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none"
          />
          <Button
            type="submit"
            size="sm"
            disabled={!input.trim() || thinking}
            className="rounded-xl bg-gradient-to-br from-violet-500 to-fuchsia-500 text-white hover:from-violet-400 hover:to-fuchsia-400"
          >
            {thinking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </Button>
        </div>
      </form>
    </div>
  );
}

function WidgetView({ widget }: { widget: AssistantWidget }) {
  if (widget.type === "weather") {
    const w = widget.data;
    return (
      <div className="overflow-hidden rounded-2xl border border-zinc-800 bg-gradient-to-br from-sky-600/30 via-zinc-900/80 to-zinc-900/80 p-6 shadow-xl backdrop-blur-xl">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-sm text-zinc-400">{w.location}</p>
            <p className="mt-1 text-5xl font-light text-white">{w.tempC}°</p>
            <p className="mt-1 text-sm text-zinc-300">{w.condition}</p>
          </div>
          <WeatherIcon condition={w.condition} className="h-16 w-16 text-sky-300" />
        </div>
        <p className="mt-2 text-xs text-zinc-400">H: {w.high}° · L: {w.low}°</p>
        <div className="mt-4 grid grid-cols-4 gap-2 border-t border-zinc-800 pt-4">
          {w.forecast?.slice(0, 4).map((f, i) => (
            <div key={i} className="flex flex-col items-center gap-1 text-center">
              <span className="text-xs text-zinc-400">{f.day}</span>
              <WeatherIcon condition={f.condition} className="h-5 w-5 text-sky-300" />
              <span className="text-sm font-medium text-zinc-100">{f.tempC}°</span>
            </div>
          ))}
        </div>
      </div>
    );
  }
  if (widget.type === "time") {
    const t = widget.data;
    return (
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-6 shadow-xl backdrop-blur-xl">
        <div className="flex items-center gap-3">
          <Clock className="h-6 w-6 text-violet-400" />
          <div>
            <p className="text-3xl font-semibold text-white">{t.time}</p>
            <p className="text-sm text-zinc-400">{t.date} · {t.location}</p>
          </div>
        </div>
      </div>
    );
  }
  if (widget.type === "timer") {
    const t = widget.data;
    const mins = Math.floor(t.seconds / 60);
    const secs = t.seconds % 60;
    return (
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-6 shadow-xl backdrop-blur-xl">
        <div className="flex items-center gap-3">
          <Timer className="h-6 w-6 text-violet-400" />
          <div>
            <p className="text-3xl font-semibold tabular-nums text-white">{String(mins).padStart(2, "0")}:{String(secs).padStart(2, "0")}</p>
            <p className="text-sm text-zinc-400">{t.label}</p>
          </div>
        </div>
      </div>
    );
  }
  if (widget.type === "list") {
    const l = widget.data;
    return (
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/70 p-6 shadow-xl backdrop-blur-xl">
        <div className="mb-3 flex items-center gap-2">
          <ListChecks className="h-5 w-5 text-violet-400" />
          <h3 className="font-semibold text-white">{l.title}</h3>
        </div>
        <ul className="space-y-1.5 text-sm text-zinc-200">
          {l.items.map((it, i) => (
            <li key={i} className="flex gap-2"><span className="text-zinc-500">{i + 1}.</span>{it}</li>
          ))}
        </ul>
      </div>
    );
  }
  return null;
}

function WeatherIcon({ condition, className }: { condition: string; className?: string }) {
  const c = condition.toLowerCase();
  if (c.includes("rain") || c.includes("shower")) return <CloudRain className={className} />;
  if (c.includes("snow")) return <CloudSnow className={className} />;
  if (c.includes("cloud") || c.includes("overcast")) return <Cloud className={className} />;
  return <Sun className={className} />;
}
