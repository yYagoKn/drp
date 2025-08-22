// index.js
// Fluxo: /w (captura code+UTMs e redireciona p/ WhatsApp) → usuário envia código → bot pede nome
// → salva em Sheets + envia p/ Leadlovers → confirma + link do grupo → ignora mensagens futuras
"use strict";

const express = require("express");
const crypto = require("crypto");

const app = express();
app.use(express.json({ type: "*/*" }));

/* ========= ENV ========= */
const PORT = process.env.PORT || 3000;

// WhatsApp Cloud API
const WA_VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN;
const WA_PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;

// Upstash Redis (REST)
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const CODE_TTL_SECONDS = Number(process.env.CODE_TTL_SECONDS || 86400);

// Mensagem inicial e telefone de destino
// Suporta {code} ou #{code} no template
const DEFAULT_MESSAGE =
  process.env.DEFAULT_MESSAGE ||
  `Quero participar do evento, meu código é #{code}\n\n*Envie o código para confirmar sua inscrição!*`;
const TARGET_PHONE_ENV =
  process.env.WHATSAPP_REDIRECT_PHONE ||
  process.env.WHATSAPP_PHONE ||
  process.env.WA_TARGET_PHONE ||
  process.env.TARGET_PHONE ||
  process.env.DEFAULT_TO_PHONE ||
  "";

// Google Apps Script (Sheets)
const SHEETS_WEBHOOK_URL = process.env.SHEETS_WEBHOOK_URL;
const SHEETS_SECRET = process.env.SHEETS_SECRET;
// defaults pedidos por você
const SHEETS_DOC_NAME = process.env.SHEETS_DOC_NAME || "UTM Logs";
const SHEETS_TAB_NAME = process.env.SHEETS_TAB_NAME || "UTMs Leads WhatsApp";

// Leadlovers
const LEADLOVERS_URL = process.env.LEADLOVERS_URL;
const LEADLOVERS_TOKEN = process.env.LEADLOVERS_TOKEN;

// Link do grupo VIP
const GROUP_LINK =
  process.env.GROUP_LINK ||
  "https://go.doutorpastagem.com.br/grupo-vivendo-pecuaria-leite";

/* ========= HELPERS ========= */
function makeTid(len = 8) {
  return crypto
    .randomBytes(Math.ceil((len * 3) / 4))
    .toString("base64")
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(0, len);
}

function sanitizePhone(raw) {
  const digits = String(raw || "").replace(/\D/g, "");
  return /^\d{10,15}$/.test(digits) ? digits : null;
}
function resolvePhone(queryPhone) {
  return sanitizePhone(queryPhone) || sanitizePhone(TARGET_PHONE_ENV);
}

function renderDefaultMessage(code, tid) {
  let msg = DEFAULT_MESSAGE;
  msg = msg.replace(/\#\{code\}/g, `#${code}`);
  msg = msg.replace(/\{code\}/g, `${code}`);
  // sempre anexa o TID para casar clique x conversa
  return `${msg}  (TID:${tid})`;
}

/* ========= UPSTASH (STORE) ========= */
async function rget(key) {
  const res = await fetch(`${UPSTASH_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  });
  const j = await res.json().catch(() => null);
  return j?.result ? JSON.parse(j.result) : null;
}
async function rset(key, value, ttlSec) {
  const body = JSON.stringify(value);
  const res = await fetch(
    `${UPSTASH_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(
      body
    )}?EX=${ttlSec}`,
    { method: "POST", headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } }
  );
  return res.json().catch(() => null);
}
async function rdel(key) {
  const res = await fetch(`${UPSTASH_URL}/del/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  });
  return res.json().catch(() => null);
}

async function saveClick(tid, data) {
  return rset(`click:${tid}`, data, CODE_TTL_SECONDS);
}
async function getClick(tid) {
  return rget(`click:${tid}`);
}
async function setState(wa_id, state) {
  return rset(`state:${wa_id}`, state, CODE_TTL_SECONDS);
}
async function getState(wa_id) {
  return rget(`state:${wa_id}`);
}
async function clearState(wa_id) {
  return rdel(`state:${wa_id}`);
}
async function markCompleted(wa_id) {
  return rset(`done:${wa_id}`, { done: true }, CODE_TTL_SECONDS);
}
async function isCompleted(wa_id) {
  const v = await rget(`done:${wa_id}`);
  return !!v?.done;
}

/* ========= INTEGRATIONS ========= */
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
    console.error("WhatsApp API error:", res.status, await res.text());
  }
}

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
    throw new Error(`Sheets error ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function sendToLeadlovers({
  phone,
  name,
  code,
  utm_source,
  utm_campaign,
  utm_medium,
  utm_content,
  utm_term,
}) {
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
    throw new Error(`Leadlovers error ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

function extractMessageText(msg) {
  return (
    (msg.text && msg.text.body) ||
    (msg.button && msg.button.text) ||
    (msg.interactive &&
      msg.interactive.button_reply &&
      msg.interactive.button_reply.title) ||
    ""
  ).trim();
}

/* ========= ROUTES ========= */

// 1) Link de redirecionamento (sem CTWA)
// Ex.: https://SEU-DOMINIO/w?code=ABC123&utm_source=instagram&utm_medium=bio...
// Se ?phone= não vier, usa TARGET_PHONE (env)
app.get("/w", async (req, res) => {
  try {
    const { code, phone, ...utms } = req.query;
    if (!code) return res.status(400).send("code é obrigatório");

    const phoneDigits = resolvePhone(phone);
    if (!phoneDigits) {
      return res
        .status(400)
        .send(
          "phone ausente ou inválido. Configure TARGET_PHONE no Render (ex.: 5511999999999) ou envie ?phone=..."
        );
    }

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

    const text = renderDefaultMessage(code, tid);
    const href = `https://api.whatsapp.com/send?phone=${phoneDigits}&text=${encodeURIComponent(
      text
    )}`;
    return res.redirect(href);
  } catch (e) {
    console.error("Route /w error:", e);
    return res.status(500).send("erro");
  }
});

// 2) Verificação do Webhook do Meta
app.get("/webhook", (req, res) => {
  try {
    const mode = req.query["hub.mode"];
    const challenge = req.query["hub.challenge"];
    const verifyToken = req.query["hub.verify_token"];
    if (mode === "subscribe" && verifyToken === WA_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.sendStatus(403);
  } catch {
    return res.sendStatus(403);
  }
});

// 3) Recebimento dos eventos WhatsApp
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body?.entry?.[0];
    const value = entry?.changes?.[0]?.value;
    const messages = value?.messages || [];
    if (!messages.length) return res.sendStatus(200);

    for (const m of messages) {
      const wa_id = m.from;
      const txt = extractMessageText(m);

      // Se já concluído, ignorar mensagens futuras
      if (await isCompleted(wa_id)) continue;

      // Se aguardando nome → qualquer texto é nome
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

        // 3.1) Sheets
        try {
          await saveRowToSheets(row);
        } catch (e) {
          console.error("Sheets error:", e.message || e);
        }

        // 3.2) Leadlovers
        try {
          await sendToLeadlovers(row);
        } catch (e) {
          console.error("Leadlovers error:", e.message || e);
        }

        // 3.3) Confirmação com resumo + link do grupo
        const confirm =
          `✅ *Inscrição confirmada!*\n` +
          `Nome: *${row.name}*\n` +
          `Código: *${row.code || "-"}*\n\n` +
          `Clique no link abaixo para entrar no *Grupo VIP do evento*:\n` +
          `📎 ${GROUP_LINK}`;
        await sendWhatsAppText(wa_id, confirm);

        await clearState(wa_id);
        await markCompleted(wa_id);
        continue;
      }

      // Primeira mensagem: deve conter #CODE e TID:xxxx (que veio do /w)
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

      // Caso não reconheça o padrão
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

/* ========= HEALTH ========= */
app.get("/health", (_, res) => res.send("ok"));

app.listen(PORT, () => console.log(`listening on :${PORT}`));
