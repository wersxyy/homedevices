import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

export const joinByCode = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    z.object({ code: z.string().min(4).max(12) }).parse(input),
  )
  .handler(async ({ data }) => {
    const code = data.code.trim().toUpperCase();
    const { data: device, error } = await supabaseAdmin
      .from("devices")
      .select("id, name, type")
      .eq("access_code", code)
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!device) return { ok: false as const, error: "Invalid code" };
    return { ok: true as const, device };
  });

export const recordRing = createServerFn({ method: "POST" })
  .inputValidator((input) =>
    z.object({ deviceId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }) => {
    const { error } = await supabaseAdmin
      .from("devices")
      .update({ last_ring_at: new Date().toISOString() })
      .eq("id", data.deviceId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
