// index.js
// Fluxo: grava no Sheets somente após a 1ª mensagem (casando #CODE com UTMs) + pede nome

const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();

// --------- CONFIG (env) ----------
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN || "changeme";
const TARGET_PHONE = process.env.TARGET_PHONE || "5546991305630";

// Template com placeholder {code}; substituímos na hora de montar a mensagem
const DEFAULT_MESSAGE =
  process.env.DEFAULT_MESSAGE ||
  "Quero participar do evento, meu código é #{code} - *Envie o código para confirmar sua inscrição!*";

const LEADLOVERS_URL = process.env.LEADLOVERS_URL || "https://api.zaplovers.com/api/cloudapi/webhooks";
const LEADLOVERS_TOKEN = process.env.LEADLOVERS_TOKEN || "";

const SHEETS_WEBHOOK_URL = process.env.SHEETS_WEBHOOK_URL || "";
const SHEETS_SECRET = process.env.SHEETS_SECRET || "";

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "";          // para enviar respostas automáticas
const WA_PHONE_NUMBER_ID_ENV = process.env.WA_PHONE_NUMBER_ID || ""; // opcional

const CODE_TTL_SECONDS = parseInt(process.env.CODE_TTL_SECONDS || "86400", 10); // 24h
const LOG_FILE = path.join("/mnt/data", "utm_click_buffer.csv"); // opcional/volátil

// Buffers em memória
global.__utmBuffer = global.__utmBuffer || new Map(); // code -> {utms, ip, ua, ts}
global.__lastHits = global.__lastHits || new Map();   // debounce
global.__nameWait = global.__nameWait || new Map();   // phone -> { code, utms..., ts }

function genCode(len = 5) {
  return Array.from({ length: len })
    .map(() => Math.random().toString(36).slice(2, 3))
    .join("")
    .toUpperCase();
}
function nowSec() { return Math.floor(Date.now() / 1000); }
function purgeExpired() {
  const now = nowSec();
  for (const [code, rec] of global.__utmBuffer.entries()) {
    if (now - rec.ts > CODE_TTL_SECONDS) global.__utmBuffer.delete(code);
  }
}
function purgeNameWait(ttlSeconds = 86400) {
  const now = nowSec();
  for (const [phone, rec] of global.__nameWait.entries()) {
    if (now - rec.ts > ttlSeconds) global.__nameWait.delete(phone);
  }
}

async function sendWhatsappText(to, body, phoneNumberIdFromWebhook) {
  if (!WHATSAPP_TOKEN) return; // sem token, não responde
  const phoneNumberId = WA_PHONE_NUMBER_ID_ENV || phoneNumberIdFromWebhook;
  if (!phoneNumberId) return console.warn("Sem WA_PHONE_NUMBER_ID; não enviarei resposta.");
  try {
    const resp = await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        text: { body }
      })
    });
    console.log("Send WA msg:", resp.status, await resp.text());
  } catch (e) {
    console.error("Erro send WA:", e.message);
  }
}

// --------- MIDDLEWARE ----------
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// --------- HEALTH ----------
app.get("/health", (_req, res) => res.status(200).send("ok"));

// --------- WEBHOOK VERIFICATION (GET) ----------
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

// --------- WEBHOOK RECEIVER (POST) ----------
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;
    console.log(">>> WEBHOOK BODY:", JSON.stringify(body, null, 2));

    if (body?.object === "whatsapp_business_account") {
      for (const entry of body.entry || []) {
        for (const change of entry.changes || []) {
          const data = change.value || {};
          const phoneNumberIdFromWebhook = data.metadata?.phone_number_id;

          // Mensagens recebidas
          for (const msg of data.messages || []) {
            const from = msg.from;              // telefone do lead
            const text = msg.text?.body || "";
            console.log(">>> INCOMING:", { from, text });

            // 1) Se a mensagem tem #CODE → guardar pendência e pedir nome
            const codeMatch = text.match(/#([A-Z0-9]{4,8})\b/i);
            if (codeMatch) {
              const code = codeMatch[1].toUpperCase();
              purgeExpired(); // limpa buffer de cliques expirados
              const rec = global.__utmBuffer.get(code);
              if (rec) {
                global.__nameWait.set(from, {
                  code,
                  utm_source: rec.utm_source,
                  utm_campaign: rec.utm_campaign,
                  utm_medium: rec.utm_medium,
                  utm_content: rec.utm_content,
                  utm_term: rec.utm_term,
                  ip: rec.ip || "",
                  user_agent: rec.user_agent || "",
                  ts: nowSec()
                });

                // pede o nome (se tiver token)
                await sendWhatsappText(
                  from,
                  "Sua inscrição foi confirmada! Para receber o link do grupo, digite seu nome completo.",
                  phoneNumberIdFromWebhook
                );

                // remove o code do buffer para não reutilizar
                global.__utmBuffer.delete(code);
                continue; // não envia ao Sheets ainda
              } else {
                console.log(">>> CODE não encontrado/expirado:", code);
              }
            }

            // 2) Se NÃO tem #CODE, mas existe pendência para este phone → tratar como nome
            purgeNameWait();
            const pending = global.__nameWait.get(from);
            if (pending) {
              const name = text.trim().slice(0, 120); // limite básico

              // montar payload para Sheets com name
              const payload = {
                secret: SHEETS_SECRET,
                code: pending.code,
                phone: from,
                name,
                utm_source: pending.utm_source,
                utm_campaign: pending.utm_campaign,
                utm_medium: pending.utm_medium,
                utm_content: pending.utm_content,
                utm_term: pending.utm_term,
                ip: pending.ip,
                user_agent: pending.user_agent
              };

              try {
                if (!SHEETS_WEBHOOK_URL) {
                  console.warn("SHEETS_WEBHOOK_URL não configurada");
                } else {
                  const resp = await fetch(SHEETS_WEBHOOK_URL, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(payload),
                  });
                  console.log("Sheets webhook (name):", resp.status, await resp.text());
                }
              } catch (err) {
                console.error("Erro ao enviar nome ao Sheets:", err.message);
              }

              // confirma ao usuário (opcional)
              await sendWhatsappText(
                from,
                "Perfeito, obrigado! Em instantes você receberá o link do grupo. ✅",
                phoneNumberIdFromWebhook
              );

              // limpar pendência
              global.__nameWait.delete(from);
              continue;
            }

            // CTWA referral (extra)
            if (msg.referral) {
              const r = msg.referral;
              console.log(">>> CTWA REFERRAL:", {
                source_type: r.source_type,
                source_url: r.source_url,
                headline: r.headline,
                body: r.body,
                media_type: r.media_type,
                media_url: r.media_url,
                ad_id: r.ad_id || r.ads_id || null,
              });
            }
          }

          // Status (delivered/read/etc.)
          for (const st of data.statuses || []) {
            console.log(">>> MESSAGE STATUS:", {
              id: st.id,
              status: st.status,
              recipient_id: st.recipient_id,
              timestamp: st.timestamp,
              conversation: st.conversation,
              pricing: st.pricing,
            });
          }
        }
      }
    }

    // Relay para LeadLovers (assíncrono)
    ;(async () => {
      if (!LEADLOVERS_URL || !LEADLOVERS_TOKEN) return;
      try {
        const url = `${LEADLOVERS_URL}?token=${encodeURIComponent(LEADLOVERS_TOKEN)}`;
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const text = await resp.text();
        console.log("LeadLovers relay:", resp.status, text.slice(0, 500));
      } catch (err) {
        console.error("LeadLovers relay erro:", err.message);
      }
    })();

    return res.sendStatus(200);
  } catch (e) {
    console.error("Webhook error:", e);
    return res.sendStatus(200);
  }
});

// --------- REDIRECT /go -> gera #CODE, salva UTMs com TTL, abre WhatsApp ----------
app.get("/go", (req, res) => {
  const doTrack = req.query.track === "1";

  // filtro de bots (não bloqueia WhatsApp)
  const ua = (req.headers["user-agent"] || "").toLowerCase();
  const botUAs = [
    "facebookexternalhit","meta-external","slackbot",
    "twitterbot","linkedinbot","skypeuripreview","googlebot",
    "curl","python-requests","uptime","pingdom","monitor"
  ];
  const isBot = botUAs.some(sig => ua.includes(sig));

  // UTMs
  const {
    utm_source = "na",
    utm_campaign = "na",
    utm_medium = "na",
    utm_content = "na",
    utm_term = "na",
  } = req.query;

  // debounce 30s por IP+UTMs
  const ip = (req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress || "").trim();
  const key = `${ip}|${utm_source}|${utm_campaign}|${utm_medium}|${utm_content}|${utm_term}`;
  const now = Date.now();
  const last = global.__lastHits.get(key) || 0;
  const within30s = now - last < 30_000;

  // caso sem track/bot/debounce: mensagem limpa (sem código)
  if (!doTrack || isBot || within30s) {
    const cleanMsg = "Quero participar do evento";
    const waUrl = `https://wa.me/${TARGET_PHONE}?text=${encodeURIComponent(cleanMsg)}`;
    if (!doTrack) console.log(">>> /go sem track (track!=1) -> redirect-only");
    else if (isBot) console.log(">>> /go bloqueado por User-Agent de bot:", ua);
    else console.log(">>> /go debounce (mesmo IP+UTMs <30s)");
    return res.redirect(302, waUrl);
  }

  // marca hit p/ debounce
  global.__lastHits.set(key, now);

  // gerar código curto e salvar no buffer
  const code = genCode(5); // ex.: A1B2C
  purgeExpired();
  global.__utmBuffer.set(code, {
    utm_source, utm_campaign, utm_medium, utm_content, utm_term,
    ip, user_agent: req.headers["user-agent"] || "",
    ts: nowSec(),
  });

  // opcional: log de clique em CSV (volátil)
  try {
    if (!fs.existsSync(LOG_FILE)) {
      fs.writeFileSync(
        LOG_FILE,
        `"timestamp","code","utm_source","utm_campaign","utm_medium","utm_content","utm_term","ip","user_agent"\n`
      );
    }
    const row = [
      new Date().toISOString(),
      code,
      utm_source, utm_campaign, utm_medium, utm_content, utm_term,
      ip, req.headers["user-agent"] || ""
    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(",");
    fs.appendFile(LOG_FILE, row + "\n", () => {});
  } catch (err) {
    console.error("Erro no log CSV:", err.message);
  }

  // mensagem com o código aplicado ao template
  const msg = DEFAULT_MESSAGE.replace("{code}", code);
  const waUrl = `https://wa.me/${TARGET_PHONE}?text=${encodeURIComponent(msg)}`;

  console.log(">>> REDIRECT -> WHATSAPP (buffered)", {
    code, utm_source, utm_campaign, utm_medium, utm_content, utm_term
  });

  return res.redirect(302, waUrl);
});

// --------- START ----------
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
});
