// index.js
// Fluxo: grava no Sheets somente após a 1ª mensagem (casando código #ABCDE com UTMs)

const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();

// --------- CONFIG (env) ----------
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN || "changeme";
const TARGET_PHONE = process.env.TARGET_PHONE || "5546991305630";

// template com placeholder {code}; substituímos na hora de montar a mensagem
const DEFAULT_MESSAGE =
  process.env.DEFAULT_MESSAGE ||
  "Quero participar do evento, meu código é #{code} - *Envie o código para confirmar sua inscrição!*";

const LEADLOVERS_URL = process.env.LEADLOVERS_URL || "https://api.zaplovers.com/api/cloudapi/webhooks";
const LEADLOVERS_TOKEN = process.env.LEADLOVERS_TOKEN || "";

const SHEETS_WEBHOOK_URL = process.env.SHEETS_WEBHOOK_URL || "";
const SHEETS_SECRET = process.env.SHEETS_SECRET || "";

const CODE_TTL_SECONDS = parseInt(process.env.CODE_TTL_SECONDS || "86400", 10); // 24h
const LOG_FILE = path.join("/mnt/data", "utm_click_buffer.csv"); // opcional/volátil

// Buffers em memória
global.__utmBuffer = global.__utmBuffer || new Map(); // code -> {utms, ip, ua, ts}
global.__lastHits = global.__lastHits || new Map();   // debounce

// --------- HELPERS ----------
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

          // Mensagens recebidas
          for (const msg of data.messages || []) {
            const from = msg.from; // telefone do lead
            const text = msg.text?.body || "";

            console.log(">>> INCOMING:", { from, text });

            // extrair #CODE do texto
            const match = text.match(/#([A-Z0-9]{4,8})\b/i);
            if (match) {
              const code = match[1].toUpperCase();
              purgeExpired();
              const rec = global.__utmBuffer.get(code);

              if (rec) {
                // payload -> Sheets
                const payload = {
                  secret: SHEETS_SECRET,
                  code,
                  phone: from,
                  utm_source: rec.utm_source,
                  utm_campaign: rec.utm_campaign,
                  utm_medium: rec.utm_medium,
                  utm_content: rec.utm_content,
                  utm_term: rec.utm_term,
                  ip: rec.ip || "",
                  user_agent: rec.user_agent || ""
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
                    const txt = await resp.text();
                    console.log("Sheets webhook (message-link):", resp.status, txt.slice(0, 200));
                  }
                } catch (err) {
                  console.error("Erro ao enviar ao Sheets:", err.message);
                }

                // evita duplicar
                global.__utmBuffer.delete(code);
              } else {
                console.log(">>> CODE não encontrado/expirado:", code);
              }
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

  // filtro de bots
  const ua = (req.headers["user-agent"] || "").toLowerCase();
  const botUAs = [
    "facebookexternalhit","whatsapp","meta-external","slackbot",
    "twitterbot","linkedinbot","skypeuripreview","googlebot",
    "curl","python-requests","uptime","pingdom","monitor","preview"
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
