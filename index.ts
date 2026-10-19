// Edge Function "notify": envia notificação push e (opcional) WhatsApp quando nasce uma linha em `notifications`.
// Disparada por um Database Webhook (tabela notifications, evento INSERT).
// Secrets necessários: VAPID_PUBLIC, VAPID_PRIVATE, VAPID_SUBJECT (ex.: mailto:voce@email.com)
// Secrets opcionais (WhatsApp via Z-API): ZAPI_INSTANCE, ZAPI_TOKEN, ZAPI_CLIENT_TOKEN
// SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY já existem automaticamente dentro das Edge Functions.
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const pub = Deno.env.get("VAPID_PUBLIC"), prv = Deno.env.get("VAPID_PRIVATE");
if (pub && prv) webpush.setVapidDetails(Deno.env.get("VAPID_SUBJECT") ?? "mailto:contato@example.com", pub, prv);

async function sendWhatsApp(phone: string, text: string) {
  const i = Deno.env.get("ZAPI_INSTANCE"), t = Deno.env.get("ZAPI_TOKEN"), c = Deno.env.get("ZAPI_CLIENT_TOKEN");
  if (!i || !t) return;
  let d = phone.replace(/\D/g, "");
  if (d.length === 10 || d.length === 11) d = "55" + d;       // número brasileiro sem DDI
  if (d.length < 12) return;
  await fetch(`https://api.z-api.io/instances/${i}/token/${t}/send-text`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(c ? { "Client-Token": c } : {}) },
    body: JSON.stringify({ phone: d, message: text }),
  });
}

Deno.serve(async (req) => {
  try {
    const id = (await req.json())?.record?.id;
    if (!id) return new Response("ok");
    // Lê do banco (não confia no corpo da requisição) e marca como enviada de forma atômica: só o 1º envio passa.
    const { data: n } = await sb.from("notifications")
      .update({ notified_at: new Date().toISOString() }).eq("id", id).is("notified_at", null).select().maybeSingle();
    if (!n) return new Response("already sent");

    if (pub && prv) {
      const { data: subs } = await sb.from("push_subscriptions").select("*").eq("user_id", n.user_id);
      await Promise.all((subs ?? []).map(async (s) => {
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth_key } },
            JSON.stringify({ title: n.title, body: n.body }));
        } catch (e) {
          if ([404, 410].includes((e as { statusCode?: number }).statusCode ?? 0))
            await sb.from("push_subscriptions").delete().eq("id", s.id);   // aparelho desinscrito
        }
      }));
    }

    // WhatsApp: só para cliente que autorizou e só para avisos de pedido
    if (n.order_id) {
      const { data: p } = await sb.from("profiles").select("role, phone, wa_opt_in").eq("id", n.user_id).maybeSingle();
      if (p?.role === "cliente" && p.wa_opt_in && p.phone) await sendWhatsApp(p.phone, `*Sol e Lua*\n${n.title}\n${n.body ?? ""}`);
    }
    return new Response("ok");
  } catch (e) {
    return new Response(String(e), { status: 500 });
  }
});
