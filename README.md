# WhatsApp Event Reg

Fluxo: /w (captura code+UTMs e redireciona para wa.me) → usuário envia mensagem padrão → bot pede nome → salva em Sheets + envia para Leadlovers → confirma inscrição + link do grupo → ignora mensagens futuras desse número.

## Variáveis de ambiente (Render)
- PORT (opcional, ex: 10000)
- WA_VERIFY_TOKEN
- WA_PHONE_NUMBER_ID
- WHATSAPP_TOKEN
- UPSTASH_REDIS_REST_URL
- UPSTASH_REDIS_REST_TOKEN
- CODE_TTL_SECONDS (ex: 86400)
- SHEETS_WEBHOOK_URL
- SHEETS_SECRET
- SHEETS_DOC_NAME = "UTM Logs"
- SHEETS_TAB_NAME = "UTMs Leads WhatsApp"
- LEADLOVERS_URL
- LEADLOVERS_TOKEN
- GROUP_LINK

## Rotas
- GET /w?phone=55DDDNXXXXXXXX&code=ABC123&utm_source=...&utm_medium=...&utm_campaign=...&utm_content=...&utm_term=...
- GET /webhook (verificação Meta)
- POST /webhook (eventos WhatsApp)
- GET /health (healthcheck)
