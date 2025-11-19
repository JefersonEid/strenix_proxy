import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import ffmpeg from "fluent-ffmpeg";
import request from "request";
import { PassThrough } from "stream";

const app = express();
app.use(cors());

// Caminho do ffmpeg dentro do Docker/Render
const FF = "/usr/bin/ffmpeg";


// ==========================================================
// FUNÇÃO 100% COMPATÍVEL COM GOOGLE DRIVE (COM CONFIRM TOKEN)
// ==========================================================

async function downloadFromDrive(fileId) {
    const base = `https://drive.google.com/uc?export=download&id=${fileId}`;

    // PRIMEIRA REQUISIÇÃO — captura cookies e tela "scan virus"
    const first = await fetch(base, {
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
            "Accept": "text/html,application/xhtml+xml,application/xml",
        }
    });

    if (!first.ok) {
        console.error("❌ Google Drive respondeu status:", first.status);
        return null;
    }

    const firstText = await first.text();

    // Detecta token confirm=XYZ
    const confirmMatch = firstText.match(/confirm=([0-9A-Za-z_]+)/);

    // Se existe token — gera URL liberada
    if (confirmMatch) {
        const confirm = confirmMatch[1];

        const downloadUrl = 
            `https://drive.google.com/uc?export=download&confirm=${confirm}&id=${fileId}`;

        console.log("🔑 Token confirm detectado:", confirm);
        console.log("📥 Baixando usando URL liberada...");

        return await fetch(downloadUrl, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
                "Accept": "*/*"
            }
        });
    }

    // Se não há token, então o first já contém o stream
    console.log("📥 Download direto sem confirm");
    return await fetch(base, {
        headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
            "Accept": "*/*"
        }
    });
}


// ==========================================================
//                ROTA /proxy (MKV direto)
// ==========================================================

app.get("/proxy", (req, res) => {
    const fileId = req.query.fileId;
    if (!fileId) return res.status(400).send("Missing fileId");

    const url = `https://drive.google.com/uc?export=download&id=${fileId}`;
    const range = req.headers.range || null;

    const headers = {
        "User-Agent": "Mozilla/5.0",
        "Accept": "*/*",
        "Connection": "keep-alive"
    };

    if (range) headers["Range"] = range;

    request({
        url,
        headers,
        followAllRedirects: true
    })
    .on("response", (driveRes) => {
        res.status(driveRes.statusCode);
        Object.entries(driveRes.headers).forEach(([key, value]) => {
            res.setHeader(key, value);
        });
    })
    .on("error", () => res.sendStatus(500))
    .pipe(res);
});


// ==========================================================
//          ROTA /hls — HLS REAL CONVERTIDO PELO FFMPEG
// ==========================================================

app.get("/hls", async (req, res) => {
    const fileId = req.query.fileId;
    if (!fileId) return res.status(400).send("Missing fileId");

    console.log("========================================================");
    console.log("🎬 INICIANDO SESSÃO HLS");
    console.log("📁 FileId:", fileId);
    console.log("========================================================");

    const videoStream = new PassThrough();

    try {
        console.log("🌐 Conectando ao Google Drive...");
        const response = await downloadFromDrive(fileId);

        if (!response || !response.ok) {
            console.error("❌ Erro ao acessar arquivo no Google Drive");
            return res.status(500).send("Erro ao acessar Google Drive.");
        }

        console.log("📥 Google Drive liberou download.");
        response.body.pipe(videoStream);

    } catch (err) {
        console.error("❌ Erro gravíssimo ao iniciar streaming:", err);
        return res.status(500).send("Falha ao iniciar streaming.");
    }

    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");

    console.log("🎞️ Iniciando ffmpeg HLS...");

    ffmpeg(videoStream)
        .setFfmpegPath(FF)
        .addOptions([
            "-preset ultrafast",
            "-g 48",
            "-sc_threshold 0",
            "-tune zerolatency",
            "-vf scale=1280:-1",
            "-hls_time 4",
            "-hls_list_size 0",
            "-hls_flags delete_segments+append_list",
        ])
        .format("hls")
        .on("start", (cmd) => {
            console.log("🚀 FFMPEG iniciado:");
            console.log(cmd);
        })
        .on("error", (err) => {
            console.error("❌ Erro no ffmpeg:", err);
            res.end();
        })
        .pipe(res);
});


// ==========================================================
//                START DO SERVIDOR
// ==========================================================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log("");
    console.log("🔥 SERVIDOR STRENIX INICIADO!");
    console.log("🌍 Porta:", PORT);
    console.log("🛠 Rotas disponíveis:");
    console.log("   👉 GET /proxy?fileId=");
    console.log("   👉 GET /hls?fileId=");
    console.log("");
});

