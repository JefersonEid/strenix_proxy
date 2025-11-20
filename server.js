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
//  FUNÇÃO PARA LER QUALQUER ARQUIVO DO DRIVE (STREAM)
// =============================================================
async function getDriveStream(fileId) {
    try {
        const { data } = await drive.files.get(
            { fileId, alt: "media" },
            { responseType: "stream" }
        );
        return data;
    } catch (err) {
        console.error("❌ Erro ao obter stream do Drive:", err.response?.status);
        return null;
    }
}

// =============================================================
// 1) PROXY PARA ARQUIVOS TS (SEM TRANSCODIFICAR)
// =============================================================
app.get("/ts", async (req, res) => {
    const fileId = req.query.fileId;
    if (!fileId) return res.status(400).send("Missing fileId");

    const stream = await getDriveStream(fileId);
    if (!stream) return res.status(500).send("Erro ao acessar Google Drive.");

    res.setHeader("Content-Type", "video/mp2t");
    stream.pipe(res);
});

// =============================================================
// 2) PROXY DO M3U8 REAL DO DRIVE
//    - LÊ O ARQUIVO ORIGINAL
//    - REESCREVE OS CAMINHOS .TS PARA /ts?fileId=XXX
// =============================================================
app.get("/render_drive_m3u8", async (req, res) => {
    const fileId = req.query.fileId;
    if (!fileId) return res.status(400).send("Missing fileId");

    try {
        // LER O M3U8 REAL COMO TEXTO
        const file = await drive.files.get(
            { fileId, alt: "media" },
            { responseType: "text" }
        );

        let texto = file.data;

        // AQUI VOCÊ CONFIGURA SUAS PARTES DE DRIVE
        // Exemplo: segmentos nomeados "segmento_00001.ts"
        texto = texto.replace(/(segmento_\d+\.ts)/g, (match) => {
            return `/ts?fileId=${req.query.folder}_${match}`;
        });

        res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
        res.send(texto);

    } catch (err) {
        console.error("❌ Erro ao abrir m3u8:", err);
        res.status(500).send("Erro ao abrir m3u8.");
    }
});

// =============================================================
// 3) ARQUIVO M3U8 MÍNIMO (2–10 KB) — IGUAL AO STREMIO
// =============================================================
app.get("/m3u8_proxy", async (req, res) => {
    const fileId = req.query.fileId;
    if (!fileId) return res.status(400).send("Missing fileId");

    const urlBase = `${req.protocol}://${req.get("host")}`;

    const texto = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=1800000,RESOLUTION=1280x720,NAME="HD"
${urlBase}/render_drive_m3u8?fileId=${fileId}
`;

    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.send(texto);
});

// =============================================================
//  START
// =============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log("🔥 SERVIDOR STRENIX M3U8-PROXY INICIADO!");
    console.log("🌍 Porta:", PORT);
});

