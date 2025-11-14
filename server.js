import express from "express";
import cors from "cors";
import fetch from "node-fetch";
import ffmpeg from "fluent-ffmpeg";
import { PassThrough } from "stream";

const app = express();
app.use(cors());

const FF = "/usr/bin/ffmpeg"; // Render usa esse path normalmente

app.get("/hls", async (req, res) => {
    const fileId = req.query.fileId;
    if (!fileId) return res.status(400).send("Missing fileId");

    const googleUrl = `https://drive.google.com/uc?export=download&id=${fileId}`;

    const videoStream = new PassThrough();

    try {
        const response = await fetch(googleUrl, {
            headers: {
                "User-Agent": "Mozilla/5.0",
                "Accept": "*/*"
            }
        });

        if (!response.ok) {
            console.error("Erro ao acessar Google Drive:", response.status);
            return res.status(500).send("Erro ao acessar Google Drive.");
        }

        // Pipe Google → videoStream
        response.body.pipe(videoStream);
    } catch (err) {
        console.error("Erro gravíssimo:", err);
        return res.status(500).send("Falha ao iniciar streaming.");
    }

    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");

    // ffmpeg → converte MKV/MP4/AVI → HLS verdadeiro
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
            console.log("FFMPEG CMD:", cmd);
        })
        .on("error", (err) => {
            console.error("Erro no ffmpeg:", err);
            res.end();
        })
        .pipe(res);
});

app.listen(3000, () => {
    console.log("🔥 Servidor HLS no Render ativo na porta 3000");
});

