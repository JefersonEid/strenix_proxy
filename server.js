import express from "express";
import cors from "cors";
import { google } from "googleapis";
import AdmZip from "adm-zip";

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
//  CACHE EM RAM (ZIP EXTRAÍDO)
// ==================================================================
const zipCache = new Map(); // fileId → { files: Map, expires: Date }

// tempo do cache: 5 minutos
const CACHE_MS = 5 * 60 * 1000;

// ==================================================================
//  FUNÇÃO: CARREGAR ZIP DO DRIVE (COM CACHE)
// ==================================================================
async function carregarZipDrive(fileId) {
    const agora = Date.now();

    // Se temos no cache e ainda não expirou → retornar
    if (zipCache.has(fileId)) {
        const item = zipCache.get(fileId);
        if (agora < item.expires) {
            return item.files;
        }
    }

    console.log("⬇️ Baixando ZIP do Google Drive:", fileId);

    // Baixa arquivo ZIP do drive
    const res = await drive.files.get(
        { fileId, alt: "media" },
        { responseType: "arraybuffer" }
    );

    const buffer = Buffer.from(res.data);

    // Extrai o ZIP em RAM
    const zip = new AdmZip(buffer);

    // Mapeia todos os arquivos extraídos
    const arquivos = new Map();

    for (const entry of zip.getEntries()) {
        if (!entry.isDirectory) {
            arquivos.set(entry.entryName, entry.getData());
        }
    }

    console.log("📦 ZIP extraído com", arquivos.size, "arquivos.");

    // Armazena no cache
    zipCache.set(fileId, {
        files: arquivos,
        expires: agora + CACHE_MS
    });

    return arquivos;
}

// ==================================================================
//  UTIL: ACHAR ARQUIVO EM QUALQUER SUBPASTA
// ==================================================================
function findFileByEndsWith(files, ending) {
    for (const [name] of files) {
        if (name.toLowerCase().endsWith(ending.toLowerCase())) {
            return name;
        }
    }
    return null;
}

// ==================================================================
// 1) SERVIR SEGMENTO .TS
// ==================================================================
app.get("/ts_zip", async (req, res) => {
    const fileId = req.query.fileId;
    const name = req.query.name;

    if (!fileId || !name) {
        return res.status(400).send("Missing fileId or name");
    }

    try {
        const files = await carregarZipDrive(fileId);

        if (!files.has(name)) {
            return res.status(404).send("Arquivo TS não encontrado no ZIP");
        }

        res.setHeader("Content-Type", "video/mp2t");
        res.end(files.get(name));

    } catch (err) {
        console.error("❌ Erro ao servir TS:", err);
        res.status(500).send("Erro ao servir TS.");
    }
});

// ==================================================================
// 2) RENDERIZAR M3U8 COMPLETO A PARTIR DO ZIP
// ==================================================================
app.get("/hls_zip", async (req, res) => {
    const fileId = req.query.fileId;
    if (!fileId) return res.status(400).send("Missing fileId");

    try {
        const files = await carregarZipDrive(fileId);

        // Achar playlist.m3u8 em qualquer pasta
        const m3u8Name = findFileByEndsWith(files, ".m3u8");

        if (!m3u8Name) {
            return res.status(404).send("Nenhum playlist.m3u8 encontrado no ZIP");
        }

        console.log("🎵 M3U8 encontrado:", m3u8Name);

        const playlist = files.get(m3u8Name).toString("utf8");
        const linhas = playlist.split("\n");

        const newLines = [];

        for (let linha of linhas) {
            const clean = linha.trim();

            if (clean.endsWith(".ts")) {
                // extrai o nome do arquivo real usado no ZIP
                // Ex: "segmento_00012.ts"
                const nomeTS = clean.split("/").pop();

                // procurar o .ts dentro do ZIP (em subpastas também)
                const tsReal = findFileByEndsWith(files, nomeTS);

                if (tsReal) {
                    linha = `/ts_zip?fileId=${fileId}&name=${encodeURIComponent(tsReal)}`;
                } else {
                    console.warn("⚠️ TS não encontrado:", nomeTS);
                }
            }

            newLines.push(linha);
        }

        res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
        res.send(newLines.join("\n"));

    } catch (err) {
        console.error("❌ Erro no HLS ZIP:", err);
        res.status(500).send("Falha ao processar ZIP.");
    }
});

// ==================================================================
//  START SERVER
// ==================================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log("🔥 SERVIDOR STRENIX HLS ZIP INICIADO!");
    console.log("🌍 Porta:", PORT);
});

