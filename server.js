import express from "express";
import cors from "cors";
import ffmpeg from "fluent-ffmpeg";
import { PassThrough } from "stream";
import { google } from "googleapis";

const app = express();
app.use(cors());

const FF = "/usr/bin/ffmpeg";

// GOOGLE DRIVE API
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

async function getDriveStream(fileId) {
    try {
        const { data } = await drive.files.get(
            { fileId, alt: "media" },
            { responseType: "stream" }
        );
        console.log("📥 Stream de vídeo obtido via Google Drive API");
        return data;
    } catch (err) {
        console.error("❌ Erro ao obter stream do Drive:", err.response?.status);
        return null;
    }
}

// HLS REAL — LOW LATENCY MODE
app.get("/hls", async (req, res) => {

    const fileId = req.query.fileId;
    if (!fileId) return res.status(400).send("Missing fileId");

    console.log("========================================================");
    console.log("🎬 INICIANDO SESSÃO HLS (Google Drive API)");
    console.log("📁 FileId:", fileId);
    console.log("========================================================");

    const driveStream = await getDriveStream(fileId);
    if (!driveStream) return res.status(500).send("Erro ao acessar Google Drive.");

    const inputStream = new PassThrough();
    driveStream.pipe(inputStream);

    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");

    ffmpeg(inputStream)
        .inputOptions([
            "-analyzeduration", "2147483647",
            "-probesize", "2147483647",
            "-f", "matroska",
            "-fflags", "nobuffer",
            "-use_wallclock_as_timestamps", "1"
        ])
        .setFfmpegPath(FF)
        .addOptions([
            "-preset", "ultrafast",
            "-tune", "zerolatency",
            "-flags", "low_delay",
            "-avioflags", "direct",
            "-max_interleave_delta", "0",
            "-g", "48",
            "-sc_threshold", "0",
            "-vf", "scale=1280:-1",
            "-hls_time", "4",
            "-hls_list_size", "0",
            "-hls_flags", "delete_segments+append_list",
            "-max_muxing_queue_size", "99999"
        ])
        .format("hls")
        .on("start", cmd => {
            console.log("🚀 FFMPEG CMD:");
            console.log(cmd);
        })
        .on("error", err => {
            console.error("❌ Erro no ffmpeg:", err);
            try { res.end(); } catch(e){}
        })
        .pipe(res);
});

// PROXY
app.get("/proxy", async (req, res) => {
    const fileId = req.query.fileId;
    if (!fileId) return res.status(400).send("Missing fileId");

    const stream = await getDriveStream(fileId);
    if (!stream) return res.status(500).send("Erro ao acessar Google Drive.");

    res.setHeader("Content-Type", "video/mp4");
    stream.pipe(res);
});

// START SERVIDOR
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log("🔥 SERVIDOR STRENIX GOOGLE-DRIVE-HLS INICIADO!");
    console.log("🌍 Porta:", PORT);
    console.log("👉 /proxy?fileId=");
    console.log("👉 /hls?fileId=");
});

