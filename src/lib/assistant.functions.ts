import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

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
    let parsed: { text: string; widget?: { type: string; data: Record<string, unknown> } };
    try {
      parsed = JSON.parse(content);
    } catch {
      parsed = { text: String(content), widget: { type: "none", data: {} } };
    }
    return parsed;
  });
