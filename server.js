import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { nanoid } from "nanoid";
import pg from "pg";

const { Pool } = pg;

const app = express();
app.use(express.json());

// __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 정적파일
app.use(express.static(path.join(__dirname, "public")));

// 헬스체크
app.get("/api/health", (req, res) => {
  res.status(200).json({ ok: true });
});

// DB
if (!process.env.DATABASE_URL) {
  console.error("❌ DATABASE_URL env is required");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// 쿠키 파서
function parseCookies(cookieHeader = "") {
  const out = {};
  cookieHeader.split(";").forEach((part) => {
    const [k, ...rest] = part.trim().split("=");
    if (!k) return;
    out[k] = decodeURIComponent(rest.join("=") || "");
  });
  return out;
}

// 세션 토큰
app.use((req, res, next) => {
  const cookies = parseCookies(req.headers.cookie || "");
  let token = cookies.party_token;
  if (!token) {
    token = nanoid(16);
    const secure = process.env.NODE_ENV === "production" ? " Secure;" : "";
    res.setHeader(
      "Set-Cookie",
      `party_token=${encodeURIComponent(token)}; Path=/; Max-Age=${60 * 60 * 24 * 365}; SameSite=Lax;${secure}`
    );
  }
  req.partyToken = token;
  next();
});

// ✅ 에러를 502 대신 500으로 “제대로” 내려주게 래퍼
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// (여기부터 너의 ensureSchema / getRoomOne / getRoomsAll / 라우트들)
// ---- 너 코드 그대로 두되, async 라우트는 ah(...)로 감싸는 걸 추천 ----

// 공유 링크(/r/:id)
app.get("/r/:id", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// 예시: rooms
app.get("/api/rooms", ah(async (req, res) => {
  const data = await getRoomsAll(req.partyToken);
  res.json(data);
}));

// ... 나머지 라우트도 동일하게 ah(async () => {}) 형태로 감싸기 ...

// ✅ 에러 핸들러(로그 남기기)
app.use((err, req, res, next) => {
  console.error("❌ API Error:", err);
  res.status(500).json({ ok: false, error: "SERVER_ERROR" });
});

// ✅ listen은 맨 마지막에 한 번만
const PORT = Number(process.env.PORT) || 8000;
app.listen(PORT, "0.0.0.0", () => {
  console.log("✅ Server running on", PORT);
});
