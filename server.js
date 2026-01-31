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

app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// ------------------------------------------------------------------
// ENV / parâmetros
// ------------------------------------------------------------------

const PORT = parseInt(process.env.PORT || "3000", 10);
const API_TOKEN = (process.env.API_TOKEN || "").trim();
const CACHE_MS = parseInt(process.env.CACHE_MS || String(30 * 60 * 1000), 10);
const MAX_CACHE_ITEMS = parseInt(process.env.MAX_CACHE_ITEMS || "30", 10);

const TMP_DIR = process.env.TMP_DIR
  ? process.env.TMP_DIR
  : path.join(os.tmpdir(), "nix_audio_cache");

// ------------------------------------------------------------------
// Cookies YouTube (ENV → arquivo físico)
// ------------------------------------------------------------------

const COOKIES_ENV = (process.env.YOUTUBE_COOKIES_TXT || "").trim();
const COOKIES_PATH = path.join(process.cwd(), "cookies.txt");

if (COOKIES_ENV) {
  try {
    fs.writeFileSync(COOKIES_PATH, COOKIES_ENV + "\n", {
      encoding: "utf-8",
      mode: 0o600, // somente o processo
    });
    console.log("🍪 cookies.txt criado com sucesso em:", COOKIES_PATH);
  } catch (e) {
    console.error("❌ Falha ao criar cookies.txt:", e);
  }
} else {
  console.warn("⚠️ YOUTUBE_COOKIES_TXT não definido (seguindo sem cookies)");
}

// ------------------------------------------------------------------
// Garante TMP_DIR
// ------------------------------------------------------------------

try {
  fs.mkdirSync(TMP_DIR, { recursive: true });
} catch (e) {
  console.error("❌ Falha criando TMP_DIR:", TMP_DIR, e);
}

// ------------------------------------------------------------------
// Cache simples
// ------------------------------------------------------------------

const audioCache = new Map();

// ------------------------------------------------------------------
// Auth simples
// ------------------------------------------------------------------

function requireAuth(req, res) {
  if (!API_TOKEN) return true;

  const header =
    (req.headers["x-api-key"] ||
      req.headers["x-api-token"] ||
      req.headers["authorization"] ||
      "")
      .toString()
      .trim();

  const token = header.toLowerCase().startsWith("bearer ")
    ? header.substring("bearer ".length).trim()
    : header;

  if (!token || token !== API_TOKEN) {
    res.status(401).json({
      ok: false,
      error: "unauthorized",
      message: "Token inválido.",
    });
    return false;
  }
  return true;
}

// ------------------------------------------------------------------
// Utilidades
// ------------------------------------------------------------------

function isProbablyYouTubeUrl(url) {
  if (!url) return false;
  const u = url.toLowerCase();
  return (
    u.includes("youtube.com/watch") ||
    u.includes("youtu.be/") ||
    u.includes("youtube.com/shorts") ||
    u.includes("music.youtube.com/") ||
    u.includes("youtube.com/live")
  );
}

function normalizeQuality(q) {
  const n = parseInt(String(q || "192"), 10);
  if (Number.isNaN(n)) return 192;
  if (n < 64) return 64;
  if (n > 320) return 320;
  return n;
}

function makeId(videoUrl, qualityKbps) {
  const h = crypto.createHash("sha256");
  h.update(videoUrl);
  h.update("|");
  h.update(String(qualityKbps));
  return h.digest("hex").substring(0, 24);
}

function getBaseUrl(req) {
  const proto = (req.headers["x-forwarded-proto"] || req.protocol || "http")
    .toString()
    .split(",")[0]
    .trim();
  const host = (req.headers["x-forwarded-host"] || req.headers["host"])
    .toString()
    .split(",")[0]
    .trim();
  return `${proto}://${host}`;
}

// ------------------------------------------------------------------
// Cache cleanup
// ------------------------------------------------------------------

function cleanupCache() {
  const now = Date.now();

  for (const [id, item] of audioCache.entries()) {
    if (!item || now >= item.expiresAt) {
      try {
        if (item?.filePath && fs.existsSync(item.filePath)) {
          fs.unlinkSync(item.filePath);
        }
      } catch {}
      audioCache.delete(id);
    }
  }

  if (audioCache.size > MAX_CACHE_ITEMS) {
    const arr = Array.from(audioCache.values()).sort(
      (a, b) => a.createdAt - b.createdAt
    );
    const excess = audioCache.size - MAX_CACHE_ITEMS;
    for (let i = 0; i < excess; i++) {
      const it = arr[i];
      try {
        if (it?.filePath && fs.existsSync(it.filePath)) {
          fs.unlinkSync(it.filePath);
        }
      } catch {}
      audioCache.delete(it.id);
    }
  }
}

setInterval(cleanupCache, 60 * 1000);

// ------------------------------------------------------------------
// Exec util
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

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ out, err });
      else reject(new Error(err || `exit code ${code}`));
    });
  });
}

// ------------------------------------------------------------------
// Metadata
// ------------------------------------------------------------------

async function fetchMeta(videoUrl) {
  const args = [
    "-J",
    "--no-playlist",
    "--skip-download",
    ...(COOKIES_ENV ? ["--cookies", COOKIES_PATH] : []),
    videoUrl,
  ];

  try {
    const { out } = await runCommand("yt-dlp", args, { cwd: TMP_DIR });
    const json = JSON.parse(out || "{}");
    return {
      title: (json.title || "").toString(),
      duration: Number.isFinite(json.duration) ? json.duration : null,
    };
  } catch (e) {
    console.warn("⚠️ Falha metadata:", e.message);
    return { title: "", duration: null };
  }
}

// ------------------------------------------------------------------
// Conversão MP3
// ------------------------------------------------------------------

async function convertToMp3(videoUrl, qualityKbps, outPath) {
  const baseNoExt = outPath.replace(/\.mp3$/i, "");
  const template = baseNoExt + ".%(ext)s";

  const args = [
    "--no-playlist",
    "--extract-audio",
    "--audio-format",
    "mp3",
    "--audio-quality",
    `${qualityKbps}K`,
    ...(COOKIES_ENV ? ["--cookies", COOKIES_PATH] : []),
    "-o",
    template,
    videoUrl,
  ];

  await runCommand("yt-dlp", args, { cwd: TMP_DIR });

  const finalMp3 = baseNoExt + ".mp3";
  if (!fs.existsSync(finalMp3)) {
    throw new Error("MP3 não gerado.");
  }
  return finalMp3;
}

// ------------------------------------------------------------------
// Rotas
// ------------------------------------------------------------------

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    cache_items: audioCache.size,
    cookies_enabled: Boolean(COOKIES_ENV),
    tmp_dir: TMP_DIR,
    time: new Date().toISOString(),
  });
});

app.post("/music", async (req, res) => {
  if (!requireAuth(req, res)) return;

  const videoUrl = (req.body?.video_url || "").trim();
  const qualityKbps = normalizeQuality(req.body?.quality || 192);

  if (!videoUrl || !isProbablyYouTubeUrl(videoUrl)) {
    return res.status(400).json({ ok: false, error: "invalid_url" });
  }

  const id = makeId(videoUrl, qualityKbps);
  const now = Date.now();

  if (audioCache.has(id)) {
    const item = audioCache.get(id);
    if (item && now < item.expiresAt && fs.existsSync(item.filePath)) {
      return res.json({
        ok: true,
        cached: true,
        id,
        audio_url: `${getBaseUrl(req)}/music/${id}.mp3`,
      });
    }
  }

  try {
    const meta = await fetchMeta(videoUrl);
    const outPath = path.join(TMP_DIR, `${id}.mp3`);
    const finalMp3 = await convertToMp3(videoUrl, qualityKbps, outPath);

    const stat = fs.statSync(finalMp3);
    const expiresAt = now + CACHE_MS;

    audioCache.set(id, {
      id,
      createdAt: now,
      expiresAt,
      filePath: finalMp3,
      title: meta.title,
      duration: meta.duration,
      qualityKbps,
    });

    return res.json({
      ok: true,
      cached: false,
      id,
      title: meta.title,
      duration: meta.duration,
      audio_url: `${getBaseUrl(req)}/music/${id}.mp3`,
    });
  } catch (e) {
    console.error("❌ Conversão falhou:", e.message);
    return res.status(500).json({ ok: false, error: "conversion_failed" });
  }
});

app.get("/music/:id.mp3", (req, res) => {
  if (!requireAuth(req, res)) return;

  const id = req.params.id;
  const item = audioCache.get(id);

  if (!item || !fs.existsSync(item.filePath)) {
    return res.status(404).end();
  }

  res.setHeader("Content-Type", "audio/mpeg");
  fs.createReadStream(item.filePath).pipe(res);
});

// ------------------------------------------------------------------
// Start
// ------------------------------------------------------------------

app.listen(PORT, () => {
  console.log("🔥 NIX MUSIC CONVERTER ONLINE");
  console.log("🌍 Porta:", PORT);
  console.log("🍪 Cookies:", COOKIES_ENV ? "ATIVOS" : "DESATIVADOS");
});
