import express from "express";
import request from "request";
import cors from "cors";

const app = express();
app.use(cors());

app.get("/proxy", (req, res) => {
    const fileId = req.query.fileId;
    if (!fileId) {
        return res.status(400).send("Missing fileId");
    }

    const url = `https://drive.google.com/uc?export=download&id=${fileId}`;
    const range = req.headers.range || null;

    const headers = {
        "User-Agent": "Mozilla/5.0",
        "Accept": "*/*",
        "Connection": "keep-alive"
    };

    if (range) {
        headers["Range"] = range;
    }

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Strenix Proxy ativo na porta " + PORT));

