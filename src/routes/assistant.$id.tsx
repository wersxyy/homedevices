import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Maximize2, Minimize2, Mic, MicOff, Loader2, Cloud, CloudRain, Sun, CloudSnow, Clock, Timer, ListChecks } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/lib/use-auth";
import { askAssistant, type AssistantReply, type AssistantWidget } from "@/lib/assistant.functions";

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

  const recogRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const awakeRef = useRef(false);
  const nameRef = useRef("");
  const restartTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  const speak = useCallback((text: string) => {
    if (typeof window === "undefined" || !window.speechSynthesis) return;
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 1.02;
      u.pitch = 1;
      window.speechSynthesis.speak(u);
    } catch {
      // ignore
    }
  }, []);

  const handleQuery = useCallback(
    async (query: string) => {
      if (!device) return;
      setThinking(true);
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
        // Listen for wake word
        const name = nameRef.current;
        const idx = heard.lastIndexOf(name);
        if (idx !== -1) {
          // Get text AFTER the wake word
          const after = heard.slice(idx + name.length).replace(/^[\s,.!?]+/, "").trim();
          if (finalText && after) {
            awakeRef.current = true;
            setAwake(true);
            setTranscript(after);
            handleQuery(after);
          } else if (finalText) {
            // wake word only — wait for next utterance
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
      // auto-restart
      if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
      restartTimerRef.current = setTimeout(() => {
        try {
          recog.start();
        } catch {
          // already running
        }
      }, 250);
    };
    recog.onerror = (e: any) => {
      if (e.error === "not-allowed" || e.error === "service-not-allowed") {
        toast.error("Microphone access denied");
        setSupported(false);
      }
    };

    try {
      recog.start();
    } catch {
      // ignore
    }

    return () => {
      if (restartTimerRef.current) clearTimeout(restartTimerRef.current);
      try {
        recog.onend = null;
        recog.stop();
      } catch {
        // ignore
      }
    };
  }, [device, handleQuery]);

  useEffect(() => {
    return () => {
      if (clearTimerRef.current) clearTimeout(clearTimerRef.current);
      if (typeof window !== "undefined" && window.speechSynthesis) window.speechSynthesis.cancel();
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
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);

  if (!device) {
    return <div className="grid min-h-screen place-items-center text-muted-foreground">Loading…</div>;
  }

  return (
    <div ref={containerRef} className="relative min-h-screen overflow-hidden bg-gradient-to-br from-background via-background to-primary/10 text-foreground">
      {/* Header */}
      <header className="absolute left-0 right-0 top-0 z-20 flex items-center justify-between px-5 py-4">
        {!fullscreen && (
          <Link to="/dashboard" className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
            <ArrowLeft className="mr-1 h-4 w-4" /> Back
          </Link>
        )}
        <div className="ml-auto flex items-center gap-2">
          <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium ${listening ? "bg-emerald-500/15 text-emerald-400" : "bg-muted text-muted-foreground"}`}>
            {listening ? <Mic className="h-3 w-3" /> : <MicOff className="h-3 w-3" />}
            {listening ? "Listening" : "Off"}
          </span>
          <Button variant="ghost" size="sm" onClick={toggleFullscreen}>
            {fullscreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </Button>
        </div>
      </header>

      <main className="mx-auto flex min-h-screen max-w-3xl flex-col items-center justify-center px-6 py-20">
        {!supported && (
          <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-4 text-sm">
            Speech recognition isn't available in this browser. Try Chrome.
          </div>
        )}

        {/* Orb */}
        <div className="relative mb-8">
          <div className={`grid h-40 w-40 place-items-center rounded-full bg-gradient-to-br from-primary to-primary/40 shadow-2xl transition-all duration-500 ${awake || thinking ? "scale-110 shadow-primary/50" : "scale-100"}`}>
            <div className={`absolute inset-0 rounded-full bg-primary/30 blur-2xl transition-opacity ${awake || thinking ? "opacity-100" : "opacity-40"}`} />
            {thinking ? (
              <Loader2 className="relative h-14 w-14 animate-spin text-primary-foreground" />
            ) : (
              <Mic className={`relative h-14 w-14 text-primary-foreground transition-transform ${awake ? "scale-110" : ""}`} />
            )}
          </div>
        </div>

        <h1 className="text-3xl font-semibold tracking-tight">{device.name}</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {thinking
            ? "Thinking…"
            : awake
              ? "I'm listening…"
              : `Say "${device.name}, …" to wake me`}
        </p>

        {transcript && (
          <p className="mt-6 max-w-xl text-center text-lg italic text-foreground/80">"{transcript}"</p>
        )}

        {reply && (
          <div className="mt-8 w-full max-w-xl space-y-4 animate-in fade-in slide-in-from-bottom-4">
            <div className="rounded-2xl border bg-card/80 p-5 text-base shadow-sm backdrop-blur">
              {reply.text}
            </div>
            {reply.widget && reply.widget.type !== "none" && <WidgetView widget={reply.widget} />}
          </div>
        )}
      </main>
    </div>
  );
}

function WidgetView({ widget }: { widget: AssistantWidget }) {
  if (widget.type === "weather") {
    const w = widget.data;
    return (
      <div className="overflow-hidden rounded-2xl border bg-gradient-to-br from-sky-500/20 via-card to-card p-6 shadow-lg backdrop-blur">
        <div className="flex items-start justify-between">
          <div>
            <p className="text-sm text-muted-foreground">{w.location}</p>
            <p className="mt-1 text-5xl font-light">{w.tempC}°</p>
            <p className="mt-1 text-sm">{w.condition}</p>
          </div>
          <WeatherIcon condition={w.condition} className="h-16 w-16 text-sky-400" />
        </div>
        <p className="mt-2 text-xs text-muted-foreground">H: {w.high}° · L: {w.low}°</p>
        <div className="mt-4 grid grid-cols-4 gap-2 border-t pt-4">
          {w.forecast?.slice(0, 4).map((f, i) => (
            <div key={i} className="flex flex-col items-center gap-1 text-center">
              <span className="text-xs text-muted-foreground">{f.day}</span>
              <WeatherIcon condition={f.condition} className="h-5 w-5 text-sky-400" />
              <span className="text-sm font-medium">{f.tempC}°</span>
            </div>
          ))}
        </div>
      </div>
    );
  }
  if (widget.type === "time") {
    const t = widget.data;
    return (
      <div className="rounded-2xl border bg-card/80 p-6 shadow-lg backdrop-blur">
        <div className="flex items-center gap-3">
          <Clock className="h-6 w-6 text-primary" />
          <div>
            <p className="text-3xl font-semibold">{t.time}</p>
            <p className="text-sm text-muted-foreground">{t.date} · {t.location}</p>
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
      <div className="rounded-2xl border bg-card/80 p-6 shadow-lg backdrop-blur">
        <div className="flex items-center gap-3">
          <Timer className="h-6 w-6 text-primary" />
          <div>
            <p className="text-3xl font-semibold tabular-nums">{String(mins).padStart(2, "0")}:{String(secs).padStart(2, "0")}</p>
            <p className="text-sm text-muted-foreground">{t.label}</p>
          </div>
        </div>
      </div>
    );
  }
  if (widget.type === "list") {
    const l = widget.data;
    return (
      <div className="rounded-2xl border bg-card/80 p-6 shadow-lg backdrop-blur">
        <div className="mb-3 flex items-center gap-2">
          <ListChecks className="h-5 w-5 text-primary" />
          <h3 className="font-semibold">{l.title}</h3>
        </div>
        <ul className="space-y-1.5 text-sm">
          {l.items.map((it, i) => (
            <li key={i} className="flex gap-2"><span className="text-muted-foreground">{i + 1}.</span>{it}</li>
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
