import express from "express";
import cors from "cors";
import { google } from "googleapis";

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
//  UTIL: LISTAR TODOS OS ARQUIVOS DA PASTA
// ==================================================================
async function listarArquivosDaPasta(folderId) {
    const lista = [];
    let pageToken = null;

    do {
        const res = await drive.files.list({
            q: `'${folderId}' in parents`,
            fields: "files(id,name,mimeType)",
            pageToken
        });

        lista.push(...res.data.files);
        pageToken = res.data.nextPageToken;
    } while (pageToken);

    return lista;
}

// ==================================================================
// 1) PROXY PARA ARQUIVOS TS (SEM TRANSCODIFICAR)
// ==================================================================
app.get("/ts", async (req, res) => {
    const fileId = req.query.fileId;
    if (!fileId) return res.status(400).send("Missing fileId");

    try {
        const { data } = await drive.files.get(
            { fileId, alt: "media" },
            { responseType: "stream" }
        );

        res.setHeader("Content-Type", "video/mp2t");
        data.pipe(res);

    } catch (err) {
        console.error("❌ Erro ao servir TS:", err);
        res.status(500).send("Erro ao acessar segmento TS.");
    }
});

// ==================================================================
// 2) RENDERIZAR O M3U8 REAL DO DRIVE — COM MAPEAMENTO AUTOMÁTICO
// ==================================================================
app.get("/render_drive_m3u8", async (req, res) => {
    const folderId = req.query.folderId;
    if (!folderId) return res.status(400).send("Missing folderId");

    try {
        // Lista todos os arquivos da pasta
        const arquivos = await listarArquivosDaPasta(folderId);

        // Procura o arquivo .m3u8
        const m3u8File = arquivos.find(arq => arq.name.endsWith(".m3u8"));
        if (!m3u8File) {
            return res.status(404).send("Nenhum arquivo .m3u8 encontrado dentro da pasta.");
        }

        // Lê o conteúdo original do m3u8
        const { data } = await drive.files.get(
            { fileId: m3u8File.id, alt: "media" },
            { responseType: "text" }
        );

        let texto = data;

        // Mapeia cada linha e substitui segmento por arquivo correto
        const linhas = texto.split("\n");

        const tsMap = {};

        // Monta um mapa numerico → arquivo do Drive
        for (const arquivo of arquivos) {
            if (arquivo.name.endsWith(".ts")) {
                const num = arquivo.name.match(/\d+/)?.[0]; // extrai número
                if (num) tsMap[num] = arquivo.id;
            }
        }

        // Substitui cada segmento
        for (let i = 0; i < linhas.length; i++) {
            const linha = linhas[i].trim();

            if (linha.endsWith(".ts")) {
                const numero = linha.match(/\d+/)?.[0];

                if (numero && tsMap[numero]) {
                    linhas[i] = `/ts?fileId=${tsMap[numero]}`;
                }
            }
        }

        const textoFinal = linhas.join("\n");

        res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
        res.send(textoFinal);

    } catch (err) {
        console.error("❌ Erro ao processar M3U8:", err);
        res.status(500).send("Erro ao processar M3U8.");
    }
});

// ==================================================================
// 3) ARQUIVO M3U8 MINIMAL (2–10 KB) — ESTILO STREAMING / STREMIO
// ==================================================================
app.get("/m3u8_proxy", async (req, res) => {
    const folderId = req.query.folderId;
    if (!folderId) return res.status(400).send("Missing folderId");

    const urlBase = `${req.protocol}://${req.get("host")}`;

    const texto = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720
${urlBase}/render_drive_m3u8?folderId=${folderId}
`;

    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
    res.send(texto);
});

// ==================================================================
//  START SERVER
// ==================================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log("🔥 SERVIDOR STRENIX HLS AUTO-ID INICIADO!");
    console.log("🌍 Porta:", PORT);
});

