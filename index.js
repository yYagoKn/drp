// index.js
// Servidor para Webhooks da WhatsApp Cloud API + Redirect com UTMs + Relay p/ LeadLovers

const express = require("express");
const app = express();

// ---------- Config ----------
const PORT = process.env.PORT || 3000;

// Token de verificação do Webhook (o mesmo que você colocar na Meta)
const VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN || "drp_token_123";

// Número de destino (apenas dígitos, com DDI). Ex.: 5546991305630
const TARGET_PHONE = process.env.TARGET_PHONE || "5546991305630";

// Mensagem padrão do /go (antes do token UTM)
const DEFAULT_MESSAGE =
  process.env.DEFAULT_MESSAGE || "Olá! Quero participar.";

// LeadLovers relay
const LEADLOVERS_URL =
  process.env.LEADLOVERS_URL ||
  "https://api.zaplovers.com/api/cloudapi/webhooks";
const LEADLOVERS_TOKEN = process.env.LEADLOVERS_TOKEN || "llwa-a127c9d9";

// Express parsers
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---------- Health ----------
app.get("/health", (req, res) => {
  res.status(200).send("ok");
});

// ---------- Webhook Verification (GET) ----------
// Callback URL que você cadastra na Meta: https://SEU_HOST/webhook
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ---------- Webhook Receiver (POST) ----------
app.post("/webhook", async (req, res) => {
  try {
    const body = req.body;
    console.log(">>> WEBHOOK BODY:", JSON.stringify(body, null, 2));

    // (Opcional) Processamento local: extrair info útil (referral de CTWA, etc.)
    try {
      if (body?.object === "whatsapp_business_account") {
        for (const entry of body.entry || []) {
          for (const change of entry.changes || []) {
            const data = change.value || {};

            // Mensagens recebidas
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
    } catch (e) {
      console.warn("Processamento local falhou (ignorado):", e.message);
    }

    // ---------- Relay para LeadLovers (assíncrono / não bloqueante) ----------
    // Em muitos casos o token é aceito via query string. Se precisarem em header, me avise que troco.
    ;(async () => {
      try {
        const url = `${LEADLOVERS_URL}?token=${encodeURIComponent(
          LEADLOVERS_TOKEN
        )}`;
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

    // Sempre responder 200 rápido (Meta exige)
    return res.sendStatus(200);
  } catch (e) {
    console.error("Webhook error:", e);
    // Ainda devolve 200 pra não quebrar retries da Meta
    return res.sendStatus(200);
  }
});

// ---------- Redirect com UTMs -> WhatsApp ----------
// Exemplo de uso:
// https://SEU_HOST/go?utm_source={{placement}}&utm_campaign={{campaign.name}}&utm_medium={{adset.name}}&utm_content={{ad.name}}&utm_term=COLD
app.get("/go", (req, res) => {
  const {
    utm_source = "na",
    utm_campaign = "na",
    utm_medium = "na",
    utm_content = "na",
    utm_term = "na",
  } = req.query;

  const tag = `SRC:${utm_source}|CMP:${utm_campaign}|MED:${utm_medium}|CNT:${utm_content}|TERM:${utm_term}`;
  const msg = `${DEFAULT_MESSAGE} [${tag}]`;

  const waUrl = `https://wa.me/${TARGET_PHONE}?text=${encodeURIComponent(msg)}`;

  console.log(">>> REDIRECT -> WHATSAPP", {
    utm_source,
    utm_campaign,
    utm_medium,
    utm_content,
    utm_term,
  });

  return res.redirect(302, waUrl);
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
});
