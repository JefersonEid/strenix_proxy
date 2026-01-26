import express from "express";
import cors from "cors";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import os from "os";
import { spawn } from "child_process";

const app = express();

// ------------------------------------------------------------------
// Configuração básica
// ------------------------------------------------------------------

// Render / proxies (para montar URL correta com https)
app.set("trust proxy", 1);

// CORS liberado (você pode restringir depois se quiser)
app.use(cors());

// JSON body
app.use(express.json({ limit: "1mb" }));

// ------------------------------------------------------------------
// ENV / parâmetros
// ------------------------------------------------------------------

// Porta
const PORT = parseInt(process.env.PORT || "3000", 10);

// Token simples (opcional). Se não setar, fica sem autenticação.
const API_TOKEN = (process.env.API_TOKEN || "").trim();

// Cache em ms (padrão 30 min)
const CACHE_MS = parseInt(process.env.CACHE_MS || String(30 * 60 * 1000), 10);

// Limite de itens no cache (padrão 30)
const MAX_CACHE_ITEMS = parseInt(process.env.MAX_CACHE_ITEMS || "30", 10);

// Pasta temporária (Render geralmente permite /tmp)
const TMP_DIR = process.env.TMP_DIR ? process.env.TMP_DIR : path.join(os.tmpdir(), "nix_audio_cache");

// Garante que TMP_DIR existe
try {
  fs.mkdirSync(TMP_DIR, { recursive: true });
} catch (e) {
  console.error("❌ Falha criando TMP_DIR:", TMP_DIR, e);
}

// ------------------------------------------------------------------
// Cache simples
// id -> { id, createdAt, expiresAt, filePath, title, sourceUrl, qualityKbps }
// ------------------------------------------------------------------
const audioCache = new Map();

// ------------------------------------------------------------------
// Util: auth simples via header
// ------------------------------------------------------------------
function requireAuth(req, res) {
  if (!API_TOKEN) return true; // sem token configurado -> sem auth

  const header =
    (req.headers["x-api-key"] || req.headers["x-api-token"] || req.headers["authorization"] || "").toString().trim();

  // Aceita:
  // - x-api-key: TOKEN
  // - x-api-token: TOKEN
  // - Authorization: Bearer TOKEN
  const token =
    header.toLowerCase().startsWith("bearer ")
      ? header.substring("bearer ".length).trim()
      : header;

  if (!token || token !== API_TOKEN) {
    res.status(401).json({
      ok: false,
      error: "unauthorized",
      message: "Token inválido. Envie x-api-key / x-api-token / Authorization: Bearer ...",
    });
    return false;
  }
  return true;
}

// ------------------------------------------------------------------
// Util: valida URL do YouTube (bem permissivo)
// ------------------------------------------------------------------
function isProbablyYouTubeUrl(url) {
  if (!url) return false;
  const u = url.toLowerCase().trim();
  return (
    u.includes("youtube.com/watch") ||
    u.includes("youtu.be/") ||
    u.includes("youtube.com/shorts") ||
    u.includes("music.youtube.com/") ||
    u.includes("youtube.com/live")
  );
}

// ------------------------------------------------------------------
// Util: normaliza qualidade (kbps)
// ------------------------------------------------------------------
function normalizeQuality(q) {
  const n = parseInt(String(q || "192"), 10);
  if (Number.isNaN(n)) return 192;
  // limite razoável
  if (n < 64) return 64;
  if (n > 320) return 320;
  return n;
}

// ------------------------------------------------------------------
// Util: cria ID determinístico (para cache)
// ------------------------------------------------------------------
function makeId(videoUrl, qualityKbps) {
  // ID estável para mesma URL + qualidade
  const h = crypto.createHash("sha256");
  h.update(String(videoUrl || "").trim());
  h.update("|");
  h.update(String(qualityKbps));
  return h.digest("hex").substring(0, 24); // curto e suficiente
}

// ------------------------------------------------------------------
// Util: montar URL base correta (https atrás do proxy)
// ------------------------------------------------------------------
function getBaseUrl(req) {
  // X-Forwarded-Proto costuma vir do Render
  const proto = (req.headers["x-forwarded-proto"] || req.protocol || "http").toString().split(",")[0].trim();
  const host = (req.headers["x-forwarded-host"] || req.headers["host"] || "").toString().split(",")[0].trim();
  return `${proto}://${host}`;
}

// ------------------------------------------------------------------
// Util: limpeza de cache (por tempo + limite)
// ------------------------------------------------------------------
function cleanupCache() {
  const now = Date.now();

  // 1) Remove expirados
  for (const [id, item] of audioCache.entries()) {
    if (!item || now >= item.expiresAt) {
      try {
        if (item?.filePath && fs.existsSync(item.filePath)) {
          fs.unlinkSync(item.filePath);
        }
      } catch (e) {
        console.warn("⚠️ Falha removendo arquivo expirado:", item?.filePath, e);
      }
      audioCache.delete(id);
    }
  }

  // 2) Se passou do limite de itens, remove os mais antigos
  if (audioCache.size > MAX_CACHE_ITEMS) {
    const arr = Array.from(audioCache.values()).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    const excess = audioCache.size - MAX_CACHE_ITEMS;
    for (let i = 0; i < excess; i++) {
      const it = arr[i];
      if (!it) continue;
      try {
        if (it.filePath && fs.existsSync(it.filePath)) {
          fs.unlinkSync(it.filePath);
        }
      } catch (e) {
        console.warn("⚠️ Falha removendo arquivo por excesso:", it.filePath, e);
      }
      audioCache.delete(it.id);
    }
  }
}

// roda a cada 60s
setInterval(cleanupCache, 60 * 1000);

// ------------------------------------------------------------------
// Util: executa um comando e captura stdout/stderr
// ------------------------------------------------------------------
function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let out = "";
    let err = "";

    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));

    child.on("error", (e) => reject(e));
    child.on("close", (code) => {
      if (code === 0) resolve({ out, err, code });
      else reject(new Error(`Command failed: ${command} ${args.join(" ")}\ncode=${code}\n${err}`));
    });
  });
}

// ------------------------------------------------------------------
// Util: tenta obter metadados (título/duração) com yt-dlp
// ------------------------------------------------------------------
async function fetchMeta(videoUrl) {
  // -J: JSON
  // --no-playlist: evita playlist inteira
  // --skip-download: garante que só pega meta
  const args = ["-J", "--no-playlist", "--skip-download", videoUrl];

  try {
    const { out } = await runCommand("yt-dlp", args, { cwd: TMP_DIR });
    const json = JSON.parse(out || "{}");
    const title = (json.title || "").toString().trim();
    const duration = Number.isFinite(json.duration) ? json.duration : null;
    return { title, duration };
  } catch (e) {
    console.warn("⚠️ Falha ao buscar metadata:", e?.message || e);
    return { title: "", duration: null };
  }
}

// ------------------------------------------------------------------
// Util: converte para MP3 usando yt-dlp + ffmpeg
// ------------------------------------------------------------------
async function convertToMp3(videoUrl, qualityKbps, outPath) {
  // Observação:
  // -x extrai áudio
  // --audio-format mp3 força MP3
  // --audio-quality 192K define bitrate (depende do ffmpeg)
  // -o define template. Vamos apontar para outPath sem extensão, porque yt-dlp
  //    costuma acrescentar extensão; mas com --audio-format mp3, o final será .mp3.
  // Para garantir, vamos usar template sem extensão e depois localizar o .mp3 gerado.

  const baseNoExt = outPath.replace(/\.mp3$/i, "");
  const template = baseNoExt + ".%(ext)s";

  const args = [
    "--no-playlist",
    "--extract-audio",
    "--audio-format",
    "mp3",
    "--audio-quality",
    `${qualityKbps}K`,
    "--ffmpeg-location",
    "ffmpeg",
    "-o",
    template,
    videoUrl,
  ];

  await runCommand("yt-dlp", args, { cwd: TMP_DIR });

  // Após rodar, o arquivo esperado é baseNoExt + ".mp3"
  const finalMp3 = baseNoExt + ".mp3";

  if (!fs.existsSync(finalMp3)) {
    // Se por algum motivo não achar, tenta varrer pelo prefixo
    const dir = path.dirname(baseNoExt);
    const prefix = path.basename(baseNoExt);
    const files = fs.readdirSync(dir);
    const found = files.find((f) => f.startsWith(prefix) && f.toLowerCase().endsWith(".mp3"));
    if (found) {
      const p = path.join(dir, found);
      fs.renameSync(p, finalMp3);
    }
  }

  if (!fs.existsSync(finalMp3)) {
    throw new Error("Arquivo MP3 final não foi gerado (yt-dlp/ffmpeg).");
  }

  return finalMp3;
}

// ------------------------------------------------------------------
// Rotas
// ------------------------------------------------------------------

app.get("/", (req, res) => {
  res.type("text/plain").send(
    [
      "Nix Music Converter Server (yt-dlp + ffmpeg)",
      "",
      "Endpoints:",
      "GET  /health",
      "POST /music (JSON: { video_url, quality })",
      "GET  /music/:id.mp3",
      "",
      "Auth (opcional): x-api-key / x-api-token / Authorization: Bearer ...",
    ].join("\n")
  );
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "nix-music-converter",
    cache_items: audioCache.size,
    tmp_dir: TMP_DIR,
    has_token_auth: Boolean(API_TOKEN),
    cache_ms: CACHE_MS,
    max_cache_items: MAX_CACHE_ITEMS,
    time: new Date().toISOString(),
  });
});

// ------------------------------------------------------------------
// POST /music
// Body:
// {
//   "video_url": "https://www.youtube.com/watch?v=...",
//   "quality": 192
// }
//
// Resposta:
// {
//   ok: true,
//   id: "...",
//   title: "...",
//   duration: 213,
//   audio_url: "https://.../music/<id>.mp3",
//   expires_in_ms: 1800000
// }
// ------------------------------------------------------------------
app.post("/music", async (req, res) => {
  if (!requireAuth(req, res)) return;

  const videoUrl = (req.body?.video_url || req.body?.url || "").toString().trim();
  const qualityKbps = normalizeQuality(req.body?.quality || req.body?.kbps || 192);

  if (!videoUrl) {
    return res.status(400).json({
      ok: false,
      error: "missing_video_url",
      message: "Envie JSON com { video_url: \"...\" }",
    });
  }

  // Não é bloqueio forte, mas ajuda a evitar lixo
  if (!isProbablyYouTubeUrl(videoUrl)) {
    return res.status(400).json({
      ok: false,
      error: "invalid_url",
      message: "URL não parece ser do YouTube.",
    });
  }

  const id = makeId(videoUrl, qualityKbps);
  const now = Date.now();

  // Se existe no cache e ainda válido
  if (audioCache.has(id)) {
    const item = audioCache.get(id);
    if (item && now < item.expiresAt && item.filePath && fs.existsSync(item.filePath)) {
      const baseUrl = getBaseUrl(req);
      return res.json({
        ok: true,
        cached: true,
        id,
        title: item.title || "",
        duration: item.duration ?? null,
        audio_url: `${baseUrl}/music/${id}.mp3`,
        expires_in_ms: Math.max(0, item.expiresAt - now),
        quality_kbps: item.qualityKbps,
      });
    }
  }

  // Não tinha cache válido -> converter
  const outPath = path.join(TMP_DIR, `${id}.mp3`);

  try {
    console.log("🎵 Convert request:", { id, qualityKbps, videoUrl });

    const meta = await fetchMeta(videoUrl);

    // Converte (yt-dlp + ffmpeg)
    const finalMp3 = await convertToMp3(videoUrl, qualityKbps, outPath);

    // Confere tamanho
    const stat = fs.statSync(finalMp3);
    if (!stat || stat.size < 10_000) {
      throw new Error("MP3 gerado muito pequeno (possível erro/blocked).");
    }

    const expiresAt = now + CACHE_MS;

    audioCache.set(id, {
      id,
      createdAt: now,
      expiresAt,
      filePath: finalMp3,
      title: meta.title || "",
      duration: meta.duration,
      sourceUrl: videoUrl,
      qualityKbps,
      sizeBytes: stat.size,
    });

    cleanupCache();

    const baseUrl = getBaseUrl(req);

    return res.json({
      ok: true,
      cached: false,
      id,
      title: meta.title || "",
      duration: meta.duration,
      audio_url: `${baseUrl}/music/${id}.mp3`,
      expires_in_ms: CACHE_MS,
      quality_kbps: qualityKbps,
      size_bytes: stat.size,
    });
  } catch (err) {
    console.error("❌ Erro convertendo:", err?.message || err);

    // Limpa lixo parcial
    try {
      if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
    } catch (e) {}

    return res.status(500).json({
      ok: false,
      error: "conversion_failed",
      message: (err?.message || String(err || "Falha desconhecida")).slice(0, 4000),
    });
  }
});

// ------------------------------------------------------------------
// GET /music/:id.mp3
// Serve o arquivo MP3 do cache
// ------------------------------------------------------------------
app.get("/music/:id.mp3", async (req, res) => {
  if (!requireAuth(req, res)) return;

  const id = (req.params?.id || "").toString().trim();
  if (!id) return res.status(400).send("Missing id");

  const item = audioCache.get(id);
  const now = Date.now();

  if (!item || now >= item.expiresAt || !item.filePath || !fs.existsSync(item.filePath)) {
    return res.status(404).json({
      ok: false,
      error: "not_found",
      message: "Áudio não encontrado ou expirado. Refaça POST /music.",
    });
  }

  // Headers para streaming
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Accept-Ranges", "bytes");

  // Nome amigável
  const safeTitle = (item.title || "audio")
    .replace(/[^\w\s\-\.]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);

  res.setHeader("Content-Disposition", `inline; filename="${safeTitle || id}.mp3"`);

  // Streaming com suporte a Range (para players)
  const fileSize = fs.statSync(item.filePath).size;
  const range = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start < 0 || end >= fileSize) {
      res.status(416).setHeader("Content-Range", `bytes */${fileSize}`).end();
      return;
    }

    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${fileSize}`);
    res.setHeader("Content-Length", end - start + 1);

    const stream = fs.createReadStream(item.filePath, { start, end });
    stream.on("error", (e) => {
      console.error("❌ Stream error:", e);
      try {
        res.end();
      } catch (_) {}
    });
    stream.pipe(res);
    return;
  }

  res.setHeader("Content-Length", fileSize);

  const stream = fs.createReadStream(item.filePath);
  stream.on("error", (e) => {
    console.error("❌ Stream error:", e);
    try {
      res.end();
    } catch (_) {}
  });
  stream.pipe(res);
});

// ------------------------------------------------------------------
// (Opcional) endpoint para limpar cache manualmente
// ------------------------------------------------------------------
app.post("/admin/clear_cache", (req, res) => {
  if (!requireAuth(req, res)) return;

  try {
    for (const item of audioCache.values()) {
      try {
        if (item?.filePath && fs.existsSync(item.filePath)) fs.unlinkSync(item.filePath);
      } catch (e) {}
    }
    audioCache.clear();
    res.json({ ok: true, message: "Cache limpo." });
  } catch (e) {
    res.status(500).json({ ok: false, message: "Falha ao limpar cache." });
  }
});

// ------------------------------------------------------------------
// Start
// ------------------------------------------------------------------
app.listen(PORT, () => {
  console.log("🔥 NIX MUSIC CONVERTER INICIADO!");
  console.log("🌍 Porta:", PORT);
  console.log("📁 TMP_DIR:", TMP_DIR);
  console.log("🧠 CACHE_MS:", CACHE_MS, "ms");
  console.log("🧱 MAX_CACHE_ITEMS:", MAX_CACHE_ITEMS);
  console.log("🔐 AUTH:", API_TOKEN ? "ATIVADO (x-api-key / bearer)" : "DESATIVADO");
});
