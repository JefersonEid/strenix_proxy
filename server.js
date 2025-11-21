import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import AdmZip from "adm-zip";

const app = express();
app.use(cors());

// ==================================================================
//  CACHE EM RAM (ZIP → { m3u8, tsMap })
// ==================================================================
const zipCache = new Map();
const CACHE_TIME = 5 * 60 * 1000; // 5 minutos

function setCache(fileId, data) {
    zipCache.set(fileId, { data, time: Date.now() });
}

function getCache(fileId) {
    const entry = zipCache.get(fileId);
    if (!entry) return null;

    if (Date.now() - entry.time > CACHE_TIME) {
        zipCache.delete(fileId);
        return null;
    }

    return entry.data;
}

// ==================================================================
//  FUNÇÃO PARA BAIXAR ARQUIVO ZIP DO GOOGLE DRIVE (STREAM)
// ==================================================================
async function baixarZIP(fileId) {
    const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&key=${process.env.GOOGLE_API_KEY}`;

    const resposta = await fetch(url);
    if (!resposta.ok) throw new Error("Erro ao baixar ZIP do Google Drive");

    return Buffer.from(await resposta.arrayBuffer());
}

// ==================================================================
//  PROCESSAR ZIP NA RAM
// ==================================================================
function processarZip(bufferZip) {
    const zip = new AdmZip(bufferZip);
    const entries = zip.getEntries();

    let m3u8File = null;
    const tsMap = {};

    // Localiza .m3u8 e .ts
    for (const e of entries) {
        if (e.entryName.endsWith(".m3u8") && !m3u8File) {
            m3u8File = e;
        }

        if (e.entryName.endsWith(".ts")) {
            const numero = e.entryName.match(/\d+/)?.[0];
            if (numero) tsMap[numero] = e;
        }
    }

    if (!m3u8File) throw new Error("Nenhum arquivo .m3u8 encontrado no ZIP");

    return { m3u8File, tsMap };
}

// ==================================================================
//  ROTAS
// ==================================================================

// -------------------------------------------------------------
// 1) RENDERIZAR M3U8 DO ZIP (COM REESCRITA DE SEGMENTOS)
// -------------------------------------------------------------
app.get("/hls_zip", async (req, res) => {
    const fileId = req.query.fileId;
    if (!fileId) return res.status(400).send("Missing fileId");

    try {
        // usa cache se existir
        let data = getCache(fileId);
        if (!data) {
            const zipBuffer = await baixarZIP(fileId);
            data = processarZip(zipBuffer);
            setCache(fileId, data);
        }

        const { m3u8File, tsMap } = data;

        let texto = m3u8File.getData().toString("utf-8");
        const linhas = texto.split("\n");

        // reescrever segmentos
        for (let i = 0; i < linhas.length; i++) {
            const l = linhas[i].trim();
            if (l.endsWith(".ts")) {
                const numero = l.match(/\d+/)?.[0];

                if (numero && tsMap[numero]) {
                    linhas[i] = `/ts_zip?fileId=${fileId}&seg=${numero}`;
                }
            }
        }

        const finalM3u8 = linhas.join("\n");

        res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
        res.send(finalM3u8);

    } catch (err) {
        console.error("Erro /hls_zip:", err);
        res.status(500).send("Erro ao processar ZIP");
    }
});

// -------------------------------------------------------------
// 2) SERVIR .TS DIRETO DO ZIP NA RAM
// -------------------------------------------------------------
app.get("/ts_zip", async (req, res) => {
    const fileId = req.query.fileId;
    const seg = req.query.seg;

    if (!fileId || !seg) return res.status(400).send("Missing params");

    try {
        const data = getCache(fileId);
        if (!data) return res.status(404).send("ZIP não carregado");

        const segFile = data.tsMap[seg];
        if (!segFile) return res.status(404).send("Segmento não encontrado");

        res.setHeader("Content-Type", "video/mp2t");
        res.send(segFile.getData());

    } catch (err) {
        console.error("Erro /ts_zip:", err);
        res.status(500).send("Erro ao servir segmento TS");
    }
});

// -------------------------------------------------------------
// 3) M3U8 MINIMAL (2 KB)
// -------------------------------------------------------------
app.get("/m3u8_zip", (req, res) => {
    const fileId = req.query.fileId;
    const urlBase = `${req.protocol}://${req.get("host")}`;

    const texto = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720
${urlBase}/hls_zip?fileId=${fileId}
`;

    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.send(texto);
});

// ==================================================================
//  START SERVER
// ==================================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log("🔥 SERVIDOR STRENIX ZIP→RAM INICIADO!");
    console.log("🌍 Porta:", PORT);
});

