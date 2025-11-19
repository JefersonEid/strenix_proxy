import express from "express";
import cors from "cors";
import ffmpeg from "fluent-ffmpeg";
import { PassThrough } from "stream";
import { google } from "googleapis";

const app = express();
app.use(cors());

// Caminho do FFmpeg no Docker Render
const FF = "/usr/bin/ffmpeg";

// ==========================================================
//   AUTENTICAÇÃO GOOGLE DRIVE API — SERVICE ACCOUNT (JWT)
// ==========================================================

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

const drive = google.drive({
    version: "v3",
    auth,
});

// ==========================================================
//   FUNÇÃO: STREAM DIRETO DO GOOGLE DRIVE VIA API OFICIAL
// ==========================================================

async function getDriveStream(fileId) {
    try {
        const { data } = await drive.files.get(
            {
                fileId: fileId,
                alt: "media",
            },
            {
                responseType: "stream",
            }
        );

        console.log("📥 Stream de vídeo obtido via Google Drive API");
        return data;
    } catch (err) {
        console.error("❌ Erro ao obter stream do Drive:", err.response?.status);
        return null;
    }
}

// ==========================================================
//   ROTA /hls — CONVERSÃO EM HLS EM TEMPO REAL COM FFMPEG
// ==========================================================

app.get("/hls", async (req, res) => {
    const fileId = req.query.fileId;
    if (!fileId) return res.status(400).send("Missing fileId");

    console.log("========================================================");
    console.log("🎬 INICIANDO SESSÃO HLS (Google Drive API)");
    console.log("📁 FileId:", fileId);
    console.log("========================================================");

    // Stream intermediário entre Google Drive e ffmpeg
    const videoStream = new PassThrough();

    try {
        const driveStream = await getDriveStream(fileId);

        if (!driveStream) {
            console.error("❌ Falha ao acessar Google Drive");
            return res.status(500).send("Erro ao acessar Google Drive.");
        }

        driveStream.pipe(videoStream);

    } catch (err) {
        console.error("❌ Erro grave:", err);
        return res.status(500).send("Falha ao iniciar streaming.");
    }

    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");

    console.log("🎞️ Iniciando ffmpeg HLS (Google Drive API)...");

    ffmpeg(videoStream)
        .inputOptions([
            "-reorder_queue_size", "99999",
            "-analyzeduration", "2147483647",
            "-probesize", "2147483647",
            "-fflags", "+discardcorrupt"
        ])
        .setFfmpegPath(FF)
        .addOptions([
            "-preset ultrafast",
            "-g 48",
            "-sc_threshold 0",
            "-tune", "zerolatency",
            "-vf", "scale=1280:-1",
            "-hls_time", "4",
            "-hls_list_size", "0",
            "-hls_flags", "delete_segments+append_list",
            "-max_muxing_queue_size", "99999"
        ])
        .format("hls")
        .on("start", (cmd) => {
            console.log("🚀 FFMPEG CMD:");
            console.log(cmd);
        })
        .on("error", (err) => {
            console.error("❌ Erro no ffmpeg:", err);
            try { res.end(); } catch {}
        })
        .pipe(res);
});

// ==========================================================
//    ROTA /proxy — STREAM DIRETO SEM HLS (OPCIONAL)
// ==========================================================

app.get("/proxy", async (req, res) => {
    const fileId = req.query.fileId;
    if (!fileId) return res.status(400).send("Missing fileId");

    try {
        const driveStream = await getDriveStream(fileId);

        if (!driveStream) {
            return res.status(500).send("Erro ao acessar Google Drive.");
        }

        res.setHeader("Content-Type", "video/mp4");
        driveStream.pipe(res);

    } catch (err) {
        console.error("❌ Erro no /proxy:", err);
        res.sendStatus(500);
    }
});

// ==========================================================
//                START DO SERVIDOR
// ==========================================================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log("");
    console.log("🔥 SERVIDOR STRENIX GOOGLE-DRIVE-HLS INICIADO!");
    console.log("🌍 Porta:", PORT);
    console.log("🛠 Rotas disponíveis:");
    console.log("   👉 GET /proxy?fileId=");
    console.log("   👉 GET /hls?fileId=");
    console.log("");
});

