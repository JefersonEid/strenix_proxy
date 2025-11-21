import express from "express";
import cors from "cors";
import { google } from "googleapis";
import AdmZip from "adm-zip"; // IMPORTANTE: para abrir o ZIP

const app = express();
app.use(cors());

// ==================================================================
//  GOOGLE DRIVE AUTH
// ==================================================================
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

// ==================================================================
// FUNÇÃO: BAIXAR ZIP COMPLETO DO GOOGLE DRIVE
// ==================================================================
async function baixarZipDoDrive(fileId) {
    const { data } = await drive.files.get(
        { fileId, alt: "media" },
        { responseType: "arraybuffer" }
    );

    return new AdmZip(Buffer.from(data));
}

// ==================================================================
// 1) /hls_zip → CARREGA E REESCREVE O PLAYLIST.M3U8 DENTRO DO ZIP
// ==================================================================
app.get("/hls_zip", async (req, res) => {
    const fileId = req.query.fileId;
    if (!fileId) return res.status(400).send("missing fileId");

    try {
        const zip = await baixarZipDoDrive(fileId);

        // LOCALIZA O ARQUIVO 'playlist.m3u8' DENTRO DO ZIP
        const entry = zip.getEntry("playlist.m3u8");
        if (!entry) {
            return res.status(404).send("playlist.m3u8 não encontrado dentro do ZIP");
        }

        // LÊ O CONTEÚDO DO PLAYLIST.M3U8
        let m3u8 = entry.getData().toString("utf8");

        // REESCREVE AS LINHAS DO TIPO "segmento_00000.ts"
        m3u8 = m3u8.replace(/segmento_(\d+)\.ts/g, (original, numero) => {
            return `/ts_zip?fileId=${fileId}&seg=${numero}`;
        });

        res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
        res.send(m3u8);

    } catch (err) {
        console.error("❌ ERRO NO /hls_zip:", err);
        res.status(500).send("Erro processando ZIP");
    }
});

// ==================================================================
// 2) /ts_zip → ENTREGA ARQUIVO .TS INTERNAMENTE DO ZIP
// ==================================================================
app.get("/ts_zip", async (req, res) => {
    const fileId = req.query.fileId;
    const segNum = req.query.seg;

    if (!fileId || !segNum) return res.status(400).send("missing parameters");

    try {
        const zip = await baixarZipDoDrive(fileId);

        const nomeArquivo = `segmento_${String(segNum).padStart(5, "0")}.ts`;

        const entry = zip.getEntry(nomeArquivo);
        if (!entry) {
            return res.status(404).send(`Segmento ${nomeArquivo} não encontrado`);
        }

        res.setHeader("Content-Type", "video/mp2t");
        res.send(entry.getData());

    } catch (err) {
        console.error("❌ ERRO NO /ts_zip:", err);
        res.status(500).send("Erro carregando segmento");
    }
});

// ==================================================================
//  INICIAR SERVIDOR
// ==================================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log("🔥 Servidor HLS ZIP INICIADO!");
    console.log("🌍 Porta:", PORT);
});

