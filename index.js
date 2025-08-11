// index.js
// WhatsApp Cloud API Webhook + Redirect /go -> Google Sheets + Relay LeadLovers (sem LID)

const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();

// --------- CONFIG (via Environment Variables no Render) ----------
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN || "changeme";
const TARGET_PHONE = process.env.TARGET_PHONE || "5546991305630";
const DEFAULT_MESSAGE = process.env.DEFAULT_MESSAGE || "Quero participar do evento";

const LEADLOVERS_URL = process.env.LEADLOVERS_URL || "https://api.zaplovers.com/api/cloudapi/webhooks";
const LEADLOVERS_TOKEN = process.env.LEADLOVERS_TOKEN || "";

const SHEETS_WEBHOOK_URL = process.env.SHEETS_WEBHOOK_URL || ""; // Apps Script Web App (/exec)
const SHEETS_SECRET = process.env.SHEETS_SECRET || "";

const LOG_FILE = path.join("/mnt/data", "utm_logs.csv"); // opcional/volátil no Render

// memória simples p/ debounce
global.__lastHits = global.__lastHits || new Map();

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

    try {
      if (body?.object === "whatsapp_business_account") {
        for (const entry of body.entry || []) {
          for (const change of entry.changes || []) {
            const data = change.value || {};

            for (const msg of data.messages || []) {
              const from = msg.from;
              const text = msg.text?.body;
              console.log(">>> INCOMING:", { from, text });

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
    } catch (e) {
      console.warn("Processamento local falhou (ignorado):", e.message);
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

// --------- REDIRECT /go -> proteções + Sheets + CSV + WhatsApp (sem LID) ----------
app.get("/go", (req, res) => {
  // 0) Exigir clique “real” com track=1
  const doTrack = req.query.track === "1";

  // 1) Filtrar bots/preview por User-Agent
  const ua = (req.headers["user-agent"] || "").toLowerCase();
  const botUAs = [
    "facebookexternalhit", "whatsapp", "meta-external", "slackbot",
    "twitterbot", "linkedinbot", "skypeuripreview", "googlebot",
    "curl", "python-requests", "uptime", "pingdom", "monitor", "preview"
  ];
  const isBot = botUAs.some(sig => ua.includes(sig));

  // 2) Coleta UTMs (mesmo se não for track, para montar URL)
  const {
    utm_source = "na",
    utm_campaign = "na",
    utm_medium = "na",
    utm_content = "na",
    utm_term = "na",
  } = req.query;

  // 3) IP e debounce
  const ip = (req.headers["x-forwarded-for"]?.split(",")[0] || req.socket.remoteAddress || "").trim();
  const key = `${ip}|${utm_source}|${utm_campaign}|${utm_medium}|${utm_content}|${utm_term}`;
  const now = Date.now();
  const last = global.__lastHits.get(key) || 0;
  const within30s = now - last < 30_000;

  // se não deve trackear, se for bot, ou se cair no debounce — só redireciona, sem log
  if (!doTrack || isBot || within30s) {
    const msg = `${DEFAULT_MESSAGE}`;
    const waUrl = `https://wa.me/${TARGET_PHONE}?text=${encodeURIComponent(msg)}`;
    if (!doTrack) console.log(">>> /go sem track (track!=1) -> redirect-only");
    else if (isBot) console.log(">>> /go bloqueado por User-Agent de bot:", ua);
    else console.log(">>> /go debounce (mesmo IP+UTMs <30s)");
    return res.redirect(302, waUrl);
  }

  // marca o hit p/ debounce
  global.__lastHits.set(key, now);

  // ---- fluxo com track válido ----
  const user_agent = req.headers["user-agent"] || "";

  // Envio ao Google Sheets (Apps Script)
  ;(async () => {
    if (!SHEETS_WEBHOOK_URL) {
      console.warn("SHEETS_WEBHOOK_URL não configurada");
      return;
    }
    try {
      const payload = {
        utm_source, utm_campaign, utm_medium, utm_content, utm_term,
        ip, user_agent,
        phone: TARGET_PHONE,
        secret: SHEETS_SECRET
      };
      const resp = await fetch(SHEETS_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const text = await resp.text();
      console.log("Sheets webhook:", resp.status, text.slice(0, 200));
    } catch (err) {
      console.error("Erro ao enviar ao Sheets:", err.message);
    }
  })();

  // (Opcional) CSV local
  try {
    if (!fs.existsSync(LOG_FILE)) {
      fs.writeFileSync(
        LOG_FILE,
        `"timestamp","utm_source","utm_campaign","utm_medium","utm_content","utm_term","ip","user_agent","phone"\n`
      );
    }
    const row = [
      new Date().toISOString(),
      utm_source,
      utm_campaign,
      utm_medium,
      utm_content,
      utm_term,
      ip,
      user_agent,
      TARGET_PHONE
    ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(",");
    fs.appendFile(LOG_FILE, row + "\n", () => {});
  } catch (err) {
    console.error("Erro no log CSV:", err.message);
  }

  // Mensagem ao usuário (limpa)
  const msg = `${DEFAULT_MESSAGE}`;
  const waUrl = `https://wa.me/${TARGET_PHONE}?text=${encodeURIComponent(msg)}`;

  console.log(">>> REDIRECT -> WHATSAPP (tracked, sem LID)", {
    utm_source, utm_campaign, utm_medium, utm_content, utm_term
  });

  return res.redirect(302, waUrl);
});

// --------- START ----------
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
});
