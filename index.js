// index.js
// WhatsApp → Captura de código/UTMs (sem CTWA) → pede NOME → salva em Sheets e envia para Leadlovers
// Depois confirma + link do grupo e ignora mensagens futuras do mesmo número.

"use strict";

const express = require("express");
const crypto = require("crypto");

const app = express();
app.use(express.json({ type: "*/*" }));

// ====== Env ======
const PORT = process.env.PORT || 3000;

// WhatsApp Cloud API
const WA_VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN;                 // ex: KSdie832nNS2332Si340AsN
const WA_PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID;           // ex: 734469813083767
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;                   // long token do Meta

// Redis (Upstash)
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;              // ex: https://xxxxx.upstash.io
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;          // ex: xxx
const CODE_TTL_SECONDS = Number(process.env.CODE_TTL_SECONDS || 86400);

// Google Apps Script (Sheets)
const SHEETS_WEBHOOK_URL = process.env.SHEETS_WEBHOOK_URL;           // seu webhook do Apps Script
const SHEETS_SECRET = process.env.SHEETS_SECRET;                     // gu1t4r_h34v1m3t4l765
const SHEETS_DOC_NAME = process.env.SHEETS_DOC_NAME || "UTM Logs";
const SHEETS_TAB_NAME = process.env.SHEETS_TAB_NAME || "UTMs Leads WhatsApp";

// Leadlovers
const LEADLOVERS_URL = process.env.LEADLOVERS_URL;                   // https://api.zaplovers.com/api/cloudapi/webhooks
const LEADLOVERS_TOKEN = process.env.LEADLOVERS_TOKEN;               // llwa-...

// Link do grupo VIP
const GROUP_LINK = process.env.GROUP_LINK || "https://go.doutorpastagem.com.br/grupo-vivendo-pecuaria-leite";

// ====== Helpers ======
function makeTid(len = 8) {
  // Gera um ID curto [a-zA-Z0-9]
  return crypto
    .randomBytes(Math.ceil((len * 3) / 4))
    .toString("base64")
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, len);
}

async function upstashGet(key) {
  const res = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  });
  const j = await res.json();
  return j?.result ? JSON.parse(j.result) : null;
}

async function upstashSet(key, value, ttlSec) {
  const body = JSON.stringify(value);
  const res = await fetch(
    `${UPSTASH_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(body)}?EX=${ttlSec}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    }
  );
  return res.json();
}

async function upstashDel(key) {
  const res = await fetch(`${UPSTASH_URL}/del/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  });
  return res.json();
}

// Store (Redis)
async function saveClick(tid, data) {
  return upstashSet(`click:${tid}`, data, CODE_TTL_SECONDS);
}
async function getClick(tid) {
  return upstashGet(`click:${tid}`);
}
async function setState(wa_id, state) {
  return upstashSet(`state:${wa_id}`, state, CODE_TTL_SECONDS);
}
async function getState(wa_id) {
  return upstashGet(`state:${wa_id}`);
}
async function clearState(wa_id) {
  return upstashDel(`state:${wa_id}`);
}
async function markCompleted(wa_id) {
  return upstashSet(`done:${wa_id}`, { done: true }, CODE_TTL_SECONDS);
}
async function isCompleted(wa_id) {
  const v = await upstashGet(`done:${wa_id}`);
  return !!v?.done;
}

// WhatsApp API
async function sendWhatsAppText(to, body) {
  const url = `https://graph.facebook.com/v20.0/${WA_PHONE_NUMBER_ID}/messages`;
  const payload = {
    messaging_product: "whatsapp",
    to,
    type: "text",
    text: { body, preview_url: false },
  };
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHATSAPP_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const errText = await res.text();
    console.error("WhatsApp API error:", res.status, errText);
  }
}

// Sheets (Apps Script)
async function saveRowToSheets(row) {
  const payload = {
    secret: SHEETS_SECRET,
    docName: SHEETS_DOC_NAME,
    tabName: SHEETS_TAB_NAME,
    data: [row],
  };
  const res = await fetch(SHEETS_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Sheets error ${res.status}: ${t}`);
  }
  return res.json();
}

// Leadlovers
async function sendToLeadlovers({ phone, name, code, utm_source, utm_campaign, utm_medium, utm_content, utm_term }) {
  const payload = {
    token: LEADLOVERS_TOKEN,
    phone,
    name,
    code,
    utm_source,
    utm_campaign,
    utm_medium,
    utm_content,
    utm_term,
  };
  const res = await fetch(LEADLOVERS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Leadlovers error ${res.status}: ${t}`);
  }
  return res.json();
}

function extractMessageText(msg) {
  return (
    (msg.text && msg.text.body) ||
    (msg.button && msg.button.text) ||
    (msg.interactive && msg.interactive.button_reply && msg.interactive.button_reply.title) ||
    ""
  ).trim();
}

// ====== Rotas ======

// Link de redirecionamento (SEM CTWA), captura code+UTMs e redireciona para wa.me
// Uso:
// https://wa.doutorpastagem.com.br/w?phone=55DDDNXXXXXXXX&code=ABC123&utm_source=instagram&utm_medium=bio&utm_campaign=evento&utm_content=post1&utm_term=xyz
app.get("/w", async (req, res) => {
  try {
    const { phone, code, ...utms } = req.query;
    if (!phone || !code) return res.status(400).send("phone e code são obrigatórios");

    const tid = makeTid(8);
    await saveClick(tid, {
      ts: new Date().toISOString(),
      code: String(code).trim(),
      utm_source: utms.utm_source || null,
      utm_campaign: utms.utm_campaign || null,
      utm_medium: utms.utm_medium || null,
      utm_content: utms.utm_content || null,
      utm_term: utms.utm_term || null,
    });

    const text =
      `Quero participar do evento, meu código é #${code}\n\n` +
      `*Envie o código para confirmar sua inscrição!*  (TID:${tid})`;

    const href = `https://wa.me/${phone}?text=${encodeURIComponent(text)}`;
    return res.redirect(href);
  } catch (e) {
    console.error("Route /w error:", e);
    return res.status(500).send("erro");
  }
});

// Verificação do Webhook (Meta)
app.get("/webhook", (req, res) => {
  try {
    const mode = req.query["hub.mode"];
    const challenge = req.query["hub.challenge"];
    const verifyToken = req.query["hub.verify_token"];
    if (mode === "subscribe" && verifyToken === WA_VERIFY_TOKEN) return res.status(200).send(challenge);
    return res.sendStatus(403);
  } catch {
    return res.sendStatus(403);
  }
});

// Recebimento de mensagens do WhatsApp
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body?.entry?.[0];
    const value = entry?.changes?.[0]?.value;
    const messages = value?.messages || [];
    if (!messages.length) return res.sendStatus(200); // sempre 200 pro Meta

    for (const m of messages) {
      const wa_id = m.from;
      const txt = extractMessageText(m);

      // Se já concluído, ignora mensagens futuras
      if (await isCompleted(wa_id)) continue;

      // Se aguardando nome: qualquer texto vira nome
      const state = await getState(wa_id);
      if (state?.awaiting_name && txt) {
        const click = state.click || (state.tid ? await getClick(state.tid) : null);

        const row = {
          timestamp: new Date().toISOString(),
          code: state.code || click?.code || null,
          phone: wa_id,
          name: txt,
          utm_source: click?.utm_source || null,
          utm_campaign: click?.utm_campaign || null,
          utm_medium: click?.utm_medium || null,
          utm_content: click?.utm_content || null,
          utm_term: click?.utm_term || null,
        };

        // Grava em Sheets
        try {
          await saveRowToSheets(row);
        } catch (e) {
          console.error("Sheets error:", e.message || e);
        }

        // Envia para Leadlovers
        try {
          await sendToLeadlovers(row);
        } catch (e) {
          console.error("Leadlovers error:", e.message || e);
        }

        // Confirmação com resumo + link do grupo
        const confirmMsg =
          `✅ *Inscrição confirmada!*\n` +
          `Nome: *${row.name}*\n` +
          `Código: *${row.code || "-"}*\n\n` +
          `Clique no link abaixo para entrar no *Grupo VIP do evento*:\n` +
          `📎 ${GROUP_LINK}`;

        await sendWhatsAppText(wa_id, confirmMsg);

        await clearState(wa_id);
        await markCompleted(wa_id);
        continue;
      }

      // Primeira mensagem: procurar #CODE e TID:xxxx
      const codeMatch = txt.match(/#([A-Z0-9_-]{3,20})/i);
      const tidMatch = txt.match(/TID:([a-zA-Z0-9_-]{5,20})/);

      if (codeMatch) {
        const code = codeMatch[1].toUpperCase();
        const tid = tidMatch?.[1] || null;
        const click = tid ? await getClick(tid) : null;

        await setState(wa_id, { awaiting_name: true, code, tid, click });

        const askName =
          `👋 Olá! Para finalizar sua inscrição:\n` +
          `➡️ *Envie seu NOME COMPLETO* nesta conversa.\n\n` +
          `Ex.: *Ana Paula de Souza*\n\n` +
          `Assim que recebermos, confirmamos sua vaga ✅`;
        await sendWhatsAppText(wa_id, askName);
        continue;
      }

      // Padrão não reconhecido
      const help =
        `Não consegui identificar seu código.\n\n` +
        `Por favor, envie a mensagem inicial ou digite seu código no formato:\n` +
        `*Quero participar do evento, meu código é #SEUCODIGO*`;
      await sendWhatsAppText(wa_id, help);
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", err);
    return res.sendStatus(200);
  }
});

// Healthcheck
app.get("/health", (_, res) => res.send("ok"));

// Start
app.listen(PORT, () => {
  console.log(`listening on :${PORT}`);
});
