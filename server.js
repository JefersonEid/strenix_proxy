import express from "express";
import cors from "cors";
import { google } from "googleapis";

const app = express();
app.use(cors());

// =============================================================
//  GOOGLE DRIVE AUTH
// =============================================================
let serviceAccountKey = null;

try {
    serviceAccountKey = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_KEY);
} catch (err) {
    console.error("❌ ERRO AO LER GOOGLE_SERVICE_ACCOUNT_KEY:", err);
}

const auth = new google.auth.GoogleAuth({
    credentials: serviceAccountKey,
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
});

const drive = google.drive({ version: "v3", auth });

// =============================================================
//  UTIL: LISTAR ARQUIVOS DENTRO DA PASTA
// =============================================================
async function listarArquivosDaPasta(folderId) {
    const lista = [];

    let pageToken = null;
    do {
        const res = await drive.files.list({
            q: `'${folderId}' in parents`,
            fields: "files(id,name,mimeType)",
            pageToken
        });

        lista.push(...res.data.files);
        pageToken = res.data.nextPageToken;
    } while (pageToken);

    return lista;
}

// =============================================================
// 1) PROXY PARA ARQUIVOS TS (SEM TRANSCODIFICAÇÃO)
// =============================================================
app.get("/ts", async (req, res) => {
    const fileId = req.query.fileId;
    if (!fileId) return res.status(400).send("Missing fileId");

    try {
        const { data } = await drive.files.get(
            { fileId, alt: "media" },
            { responseType: "stream" }
        );

        res.setHeader("Content-Type", "video/mp2t");
        data.pipe(res);

    } catch (err) {
        console.error("❌ Erro ao servir TS:", err);
        res.status(500).send("Erro ao acessar TS.");
    }
});

// =============================================================
// 2) RENDERIZAR M3U8 REAL DO DRIVE AUTOMATICAMENTE
// =============================================================
app.get("/render_drive_m3u8", async (req, res) => {
    const folderId = req.query.folderId;
    if (!folderId) return res.status(400).send("Missing folderId");

    try {
        // LISTA TUDO
        const arquivos = await listarArquivosDaPasta(folderId);

        // Acha o m3u8 original
        const m3u8 = arquivos.find(arq => arq.name.endsWith(".m3u8"));
        if (!m3u8) return res.status(404).send("Nenhum .m3u8 encontrado.");

        // Lê o conteúdo do playlist.m3u8
        const { data } = await drive.files.get(
            { fileId: m3u8.id, alt: "media" },
            { responseType: "text" }
        );

        let texto = data;

        // Para cada arquivo TS, substitui nome pelo link /ts
        arquivos.forEach(arq => {
            if (arq.name.endsWith(".ts")) {
                texto = texto.replace(
                    new RegExp(arq.name, "g"),
                    `/ts?fileId=${arq.id}`
                );
            }
        });

        res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
        res.send(texto);

    } catch (err) {
        console.error("❌ Erro ao montar m3u8:", err);
        res.status(500).send("Erro ao processar m3u8.");
    }
});

// =============================================================
// 3) ARQUIVO M3U8 MÍNIMO (2–10 KB) — IGUAL AO STREMIO
// =============================================================
app.get("/m3u8_proxy", async (req, res) => {
    const folderId = req.query.folderId;
    if (!folderId) return res.status(400).send("Missing folderId");

    const urlBase = `${req.protocol}://${req.get("host")}`;

    const texto = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720
${urlBase}/render_drive_m3u8?folderId=${folderId}
`;

    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.send(texto);
});

// =============================================================
//  START
// =============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log("🔥 SERVIDOR STRENIX HLS AUTO-ID INICIADO!");
    console.log("🌍 Porta:", PORT);
});

