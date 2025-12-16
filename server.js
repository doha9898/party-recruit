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

async function ensureSchema() {
  await pool.query(`
    create table if not exists public.rooms (
      id text primary key,
      dungeon text not null,
      time timestamptz not null,
      capacity int not null check (capacity between 2 and 20),
      host text not null,
      host_token text not null,
      created_at timestamptz not null default now()
    );
  `);

  await pool.query(`
    create table if not exists public.participants (
      id bigserial primary key,
      room_id text not null references public.rooms(id) on delete cascade,
      namejob text not null,
      token text not null,
      created_at timestamptz not null default now()
    );
  `);

  await pool.query(`
    create unique index if not exists idx_participants_room_token
      on public.participants(room_id, token);
  `);

  await pool.query(`
    create index if not exists idx_rooms_created_at
      on public.rooms(created_at desc);
  `);

  await pool.query(`
    create index if not exists idx_participants_room_id
      on public.participants(room_id);
  `);
}

async function getRoomOne(roomId, myToken) {
  const roomRes = await pool.query(`select * from public.rooms where id = $1`, [roomId]);
  if (roomRes.rowCount === 0) return null;
  const room = roomRes.rows[0];

  const pRes = await pool.query(
    `select id, room_id, namejob, token, created_at
     from public.participants
     where room_id = $1
     order by id asc`,
    [roomId]
  );

  const participants = pRes.rows.map((p) => ({
    id: p.id,
    namejob: p.namejob,
    created_at: p.created_at,
    isMe: p.token === myToken,
  }));

  const count = participants.length;

  return {
    ...room,
    participants,
    joined: participants.some((p) => p.isMe),
    isHost: room.host_token === myToken,
    count,
    isFull: count >= room.capacity,
  };
}

async function getRoomsAll(myToken) {
  const roomsRes = await pool.query(`select * from public.rooms order by created_at desc`);
  const rooms = roomsRes.rows;

  if (rooms.length === 0) return [];

  const ids = rooms.map((r) => r.id);

  const pRes = await pool.query(
    `select id, room_id, namejob, token, created_at
     from public.participants
     where room_id = any($1::text[])
     order by id asc`,
    [ids]
  );

  const byRoom = new Map();
  for (const p of pRes.rows) {
    if (!byRoom.has(p.room_id)) byRoom.set(p.room_id, []);
    byRoom.get(p.room_id).push({
      id: p.id,
      namejob: p.namejob,
      created_at: p.created_at,
      isMe: p.token === myToken,
    });
  }

  return rooms.map((r) => {
    const list = byRoom.get(r.id) || [];
    const count = list.length;
    return {
      ...r,
      participants: list,
      joined: list.some((p) => p.isMe),
      isHost: r.host_token === myToken,
      count,
      isFull: count >= r.capacity,
    };
  });
}



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

await ensureSchema();

// ✅ listen은 맨 마지막에 한 번만
const PORT = Number(process.env.PORT) || 8000;
app.listen(PORT, "0.0.0.0", () => {
  console.log("✅ Server running on", PORT);
});
