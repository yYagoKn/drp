const fs = require("fs");
const path = require("path");

// ...

app.get("/go", (req, res) => {
  const {
    utm_source = "na",
    utm_campaign = "na",
    utm_medium = "na",
    utm_content = "na",
    utm_term = "na",
  } = req.query;

  // Gera um ID curtinho pra conciliar se precisar
  const lid = Math.random().toString(36).slice(2, 8).toUpperCase();

  // 1) Salva no servidor (CSV)
  const row = [
    new Date().toISOString(),
    utm_source,
    utm_campaign,
    utm_medium,
    utm_content,
    utm_term,
    lid
  ].map(v => `"${String(v).replace(/"/g, '""')}"`).join(",");

  const logFile = path.join("/mnt/data", "utm_logs.csv");
  if (!fs.existsSync(logFile)) {
    fs.writeFileSync(logFile, `"timestamp","utm_source","utm_campaign","utm_medium","utm_content","utm_term","lid"\n`);
  }
  fs.appendFile(logFile, row + "\n", () => {});

  // 2) Mensagem limpa pro WhatsApp (com LID opcional — remova se não quiser nada)
  const msg = `${process.env.DEFAULT_MESSAGE || "Quero participar do evento"} [LID:${lid}]`;

  const waUrl = `https://wa.me/${process.env.TARGET_PHONE || "5546991305630"}?text=${encodeURIComponent(msg)}`;
  console.log(">>> REDIRECT -> WHATSAPP (logged)", { utm_source, utm_campaign, utm_medium, utm_content, utm_term, lid });
  return res.redirect(302, waUrl);
});
