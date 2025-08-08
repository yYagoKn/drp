// index.js
const express = require("express");
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ===== Config =====
const VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN || "drp_token_123"; // troque aqui e lá no app da Meta
const PORT = process.env.PORT || 3000;

// Seu número (somente dígitos, com DDI)
const TARGET_PHONE = "5546991305630";

// ===== Healthcheck =====
app.get("/health", (req, res) => {
  res.status(200).send("ok");
});

// ===== Webhook Verification (GET) =====
// Configure o webhook na Meta apontando para: https://SEU_HOST/webhook
// e use o mesmo VERIFY_TOKEN acima.
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode && token && mode === "subscribe" && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// ===== Webhook Receiver (POST) =====
// Recebe mensagens e também o 'referral' dos CTWA.
app.post("/webhook", (req, res) => {
  try {
    const body = req.body;

    // Log cru para depuração
    console.log(">>> WEBHOOK BODY:", JSON.stringify(body, null, 2));

    // Estrutura padrão da Cloud API
    if (body.object === "whatsapp_business_account" && Array.isArray(body.entry)) {
      body.entry.forEach((entry) => {
        (entry.changes || []).forEach((change) => {
          const data = change.value || {};

          // Mensagens recebidas
          const messages = data.messages || [];
          messages.forEach((msg) => {
            const from = msg.from; // telefone do lead
            const text = msg.text?.body;

            // Se veio de CTWA, a referência aparece aqui:
            const referral = msg.referral;
            if (referral) {
              // Isso é ouro para amarrar anúncio/campanha
              console.log(">>> CTWA REFERRAL:", {
                source_type: referral.source_type,
                source_url: referral.source_url,
                headline: referral.headline,
                body: referral.body,
                media_type: referral.media_type,
                media_url: referral.media_url,
                // Em algumas contas, vem como "ad_id" (ou "ads_id")
                ad_id: referral.ad_id || referral.ads_id || null,
              });
            }

            console.log(">>> INCOMING MESSAGE:", { from, text });
          });

          // Status de mensagens (entregues/lidas), útil p/ auditoria
          const statuses = data.statuses || [];
          statuses.forEach((st) => {
            console.log(">>> MESSAGE STATUS:", {
              id: st.id,
              status: st.status,
              timestamp: st.timestamp,
              recipient_id: st.recipient_id,
              conversation: st.conversation,
              pricing: st.pricing,
            });
          });
        });
      });
    }

    // Responder 200 em até 10s
    return res.sendStatus(200);
  } catch (e) {
    console.error("Webhook error:", e);
    return res.sendStatus(500);
  }
});

// ===== Redirect com UTMs -> WhatsApp =====
// Exemplo de uso (não-CTWA): 
// https://SEU_HOST/go?utm_source={{placement}}&utm_campaign={{campaign.name}}&utm_medium={{adset.name}}&utm_content={{ad.name}}&utm_term=COLD
app.get("/go", (req, res) => {
  // Coleta UTMs com defaults para evitar vazio
  const {
    utm_source = "na",
    utm_campaign = "na",
    utm_medium = "na",
    utm_content = "na",
    utm_term = "na",
  } = req.query;

  // Gera um “token” legível (curto) p/ cair no texto do WhatsApp
  const tag =
    `SRC:${utm_source}|CMP:${utm_campaign}|MED:${utm_medium}|CNT:${utm_content}|TERM:${utm_term}`;

  // Mensagem que o lead verá ao abrir o WhatsApp
  // Ajuste essa frase conforme seu fluxo (“Quero participar do evento”, etc.)
  const msg =
    `Olá! Quero participar. [${tag}]`;

  // Redireciona para o WhatsApp (cliente do usuário)
  // Pode usar wa.me ou api.whatsapp.com/send — aqui vai wa.me pela simplicidade
  const waUrl = `https://wa.me/${TARGET_PHONE}?text=${encodeURIComponent(msg)}`;

  // Log p/ auditoria
  console.log(">>> REDIRECT -> WHATSAPP", { utm_source, utm_campaign, utm_medium, utm_content, utm_term });
  return res.redirect(302, waUrl);
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
});
