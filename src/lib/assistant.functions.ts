import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

export type AssistantWidget =
  | { type: "weather"; data: { location: string; tempC: number; tempF: number; condition: string; high: number; low: number; forecast: { day: string; tempC: number; condition: string }[] } }
  | { type: "time"; data: { location: string; time: string; date: string } }
  | { type: "timer"; data: { label: string; seconds: number } }
  | { type: "list"; data: { title: string; items: string[] } }
  | { type: "none"; data: Record<string, never> };

export type AssistantReply = { text: string; widget?: AssistantWidget };



export const askAssistant = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    z
      .object({
        assistantName: z.string().min(1).max(40),
        prompt: z.string().min(1).max(500),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const key = process.env.LOVABLE_API_KEY;
    if (!key) throw new Error("Missing LOVABLE_API_KEY");

    const system = `You are ${data.assistantName}, a friendly voice assistant.
Reply with a JSON object only, no markdown, matching this schema:
{
  "text": string,            // short spoken reply, 1-3 sentences max
  "widget": {                // optional, for richer UI
    "type": "weather" | "time" | "timer" | "list" | "none",
    "data": object
  }
}
Widget data shapes:
- weather: { "location": string, "tempC": number, "tempF": number, "condition": string, "high": number, "low": number, "forecast": [{ "day": string, "tempC": number, "condition": string }] }  // 4 day forecast
- time: { "location": string, "time": string, "date": string }
- timer: { "label": string, "seconds": number }
- list: { "title": string, "items": string[] }
- none: {}
Use a widget ONLY when it visually adds value (weather, time, timers, lists). For chit-chat use "none".
Fabricate reasonable data; this is a demo. Keep text concise and conversational.`;

    const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: [
          { role: "system", content: system },
          { role: "user", content: data.prompt },
        ],
        response_format: { type: "json_object" },
      }),
    });

    if (!res.ok) {
      const txt = await res.text();
      if (res.status === 429) throw new Error("Rate limited. Try again in a moment.");
      if (res.status === 402) throw new Error("AI credits exhausted. Add credits in workspace settings.");
      throw new Error(`AI error: ${res.status} ${txt}`);
    }

    const json = await res.json();
    const content = json.choices?.[0]?.message?.content ?? "{}";
    let parsed: AssistantReply;
    try {
      parsed = JSON.parse(content) as AssistantReply;
    } catch {
      parsed = { text: String(content), widget: { type: "none", data: {} } };
    }
    return parsed as AssistantReply;
  });

export const synthesizeSpeech = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    z
      .object({
        text: z.string().min(1).max(2000),
        voice: z.string().min(1).max(40).optional(),
      })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const key = process.env.OpenAI_TTS;
    if (!key) throw new Error("Missing OpenAI_TTS key");

    const res = await fetch("https://api.openai.com/v1/audio/speech", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini-tts",
        voice: data.voice ?? "alloy",
        input: data.text,
        format: "mp3",
      }),
    });

    if (!res.ok) {
      const txt = await res.text();
      throw new Error(`TTS error: ${res.status} ${txt}`);
    }

    const buf = new Uint8Array(await res.arrayBuffer());
    let binary = "";
    for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]);
    const base64 = btoa(binary);
    return { audio: base64, mime: "audio/mpeg" };
  });
