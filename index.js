// index.js
// Webhook WhatsApp Cloud API + Redirect /go com UTMs (log em CSV) + Relay p/ LeadLovers

const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();

// ------------ CONFIG ------------
const PORT = process.env.PORT || 3000;

// Token de verificação do webhook (deve bater com o que você colocar na Meta)
const VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN || "drp_token_123";

// Número de destino (só dígitos, com DDI). Ex.: 5546991305630
const TARGET_PHONE = process.env.TARGET_PHONE || "5546991305630";

// Mensagem padrão do /go
const DEFAULT_MESSAGE = process.env.DEFAULT_MESSAGE || "Quero participar do evento";

// Relay LeadLovers
const LEADLOVERS_URL = process.env.LEADLOVERS_URL || "https://api.zaplovers.com/api/cloudapi/webhooks";
const LEADLOVERS_TOKEN = process.env.LEADLOVERS_TOKEN || "llwa-a127c9d9";

// Caminho do CSV (atenção: sem disco persistente, isto zera a cada redeploy)
const LOG_FILE = path.join("/mnt/data", "utm_logs.csv");

// ------------ MIDDLEWARES ------------
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// ------------ HEALTH ------------
app.get("/health", (_req, res) => res.status(200).send("ok"));

// ------------ WEBHOOK VERIFICATION (GET) ------------
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ------------ WEBHOOK RECEIVER (POST) ------------
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
    (async () => {
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

    // Meta exige 200 rápido
    return res.sendStatus(200);
  } catch (e) {
    console.error("Webhook error:", e);
    return res.sendStatus(200);
  }
});

// ------------ REDIRECT /go (mensagem limpa + log CSV) ------------
app.get("/go", (req, res) => {
  const {
    utm_source = "na",
    utm_campaign = "na",
    utm_medium = "na",
    utm_content = "na",
    utm_term = "na",
  } = req.query;

  // ID curto para conciliação (se quiser remover do texto, pode)
  const lid = Math.random().toString(36).slice(2, 8).toUpperCase();

  // 1) Salva no CSV (cria cabeçalho se não existir)
  try {
    if (!fs.existsSync(LOG_FILE)) {
      fs.writeFileSync(
        LOG_FILE,
        `"timestamp","utm_source","utm_campaign","utm_medium","utm_content","utm_term","lid"\n`
      );
    }
    const row = [
      new Date().toISOString(),
      utm_source,
      utm_campaign,
      utm_medium,
      utm_content,
      utm_term,
      lid,
    ]
      .map((v) => `"${String(v).replace(/"/g, '""')}"`)
      .join(",");

    fs.appendFile(LOG_FILE, row + "\n", (err) => {
      if (err) console.error("Erro ao escrever CSV:", err.message);
    });
  } catch (err) {
    console.error("Erro no log CSV:", err.message);
  }

  // 2) Mensagem limpa pro WhatsApp (com LID opcional)
  const msg = `${DEFAULT_MESSAGE} [LID:${lid}]`; // se não quiser LID, use: const msg = DEFAULT_MESSAGE;

  const waUrl = `https://wa.me/${TARGET_PHONE}?text=${encodeURIComponent(msg)}`;

  console.log(">>> REDIRECT -> WHATSAPP (logged)", {
    utm_source,
    utm_campaign,
    utm_medium,
    utm_content,
    utm_term,
    lid,
  });

  return res.redirect(302, waUrl);
});

// ------------ START ------------
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
});
