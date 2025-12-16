import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { nanoid } from "nanoid";
import pg from "pg";

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  console.error("❌ DATABASE_URL env is required");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Supabase SSL 연결용
});

const app = express();
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

app.use(express.static(path.join(__dirname, "public")));

function nowISO() {
  return new Date().toISOString();
}

function parseCookies(cookieHeader = "") {
  const out = {};
  cookieHeader.split(";").forEach((part) => {
    const [k, ...rest] = part.trim().split("=");
    if (!k) return;
    out[k] = decodeURIComponent(rest.join("=") || "");
  });
  return out;
}

// 브라우저 단위 세션 토큰(중복참가/취소/방장권한)
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
  const roomsRes = await pool.query(
    `select * from public.rooms order by created_at desc`
  );
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

// 공유 링크(/r/:id)로 들어와도 프론트가 뜨도록
app.get("/r/:id", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.get("/api/rooms", async (req, res) => {
  const data = await getRoomsAll(req.partyToken);
  res.json(data);
});

app.get("/api/rooms/:id", async (req, res) => {
  const room = await getRoomOne(req.params.id, req.partyToken);
  if (!room) return res.status(404).json({ message: "방을 찾을 수 없어." });
  res.json(room);
});

app.post("/api/rooms", async (req, res) => {
  const dungeon = String(req.body?.dungeon ?? "").trim();
  const host = String(req.body?.host ?? "").trim();
  const time = String(req.body?.time ?? "").trim(); // ISO string
  const capacity = Math.floor(Number(req.body?.capacity ?? 4));

  if (!dungeon || !host || !time) {
    return res.status(400).json({ message: "던전/시간/닉네임·직업을 모두 입력해줘." });
  }
  if (!Number.isFinite(capacity) || capacity < 2 || capacity > 20) {
    return res.status(400).json({ message: "정원은 2~20 사이로 입력해줘." });
  }

  const id = nanoid(10);
  const hostToken = req.partyToken;

  await pool.query(
    `insert into public.rooms (id, dungeon, time, capacity, host, host_token)
     values ($1, $2, $3, $4, $5, $6)`,
    [id, dungeon, time, capacity, host, hostToken]
  );

  // 방장은 자동 참가
  await pool.query(
    `insert into public.participants (room_id, namejob, token)
     values ($1, $2, $3)`,
    [id, `${host} (방장)`, hostToken]
  );

  res.json({ id });
});

app.post("/api/rooms/:id/join", async (req, res) => {
  const roomId = req.params.id;
  const namejob = String(req.body?.namejob ?? "").trim();
  if (!namejob) return res.status(400).json({ message: "닉네임/직업을 입력해줘." });

  const room = await getRoomOne(roomId, req.partyToken);
  if (!room) return res.status(404).json({ message: "방을 찾을 수 없어." });
  if (room.isFull) return res.status(409).json({ message: "정원이 꽉 찼어." });
  if (room.joined) return res.status(409).json({ message: "이미 이 방에 참가(예약)했어." });

  try {
    await pool.query(
      `insert into public.participants (room_id, namejob, token)
       values ($1, $2, $3)`,
      [roomId, namejob, req.partyToken]
    );
  } catch {
    return res.status(409).json({ message: "이미 이 방에 참가(예약)했어." });
  }

  res.json({ ok: true });
});

app.post("/api/rooms/:id/leave", async (req, res) => {
  const roomId = req.params.id;
  const room = await getRoomOne(roomId, req.partyToken);
  if (!room) return res.status(404).json({ message: "방을 찾을 수 없어." });
  if (room.isHost) return res.status(400).json({ message: "방장은 예약 취소 대신 방 삭제를 이용해줘." });

  const del = await pool.query(
    `delete from public.participants
     where room_id = $1 and token = $2`,
    [roomId, req.partyToken]
  );

  if (del.rowCount === 0) return res.status(409).json({ message: "이 방에 참가 중이 아니야." });
  res.json({ ok: true });
});

app.delete("/api/rooms/:id", async (req, res) => {
  const roomId = req.params.id;
  const roomRes = await pool.query(`select host_token from public.rooms where id = $1`, [roomId]);
  if (roomRes.rowCount === 0) return res.status(404).json({ message: "방을 찾을 수 없어." });

  if (roomRes.rows[0].host_token !== req.partyToken) {
    return res.status(403).json({ message: "방장만 삭제할 수 있어." });
  }

  await pool.query(`delete from public.rooms where id = $1`, [roomId]); // participants는 FK cascade로 삭제됨
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;

await ensureSchema();

app.listen(PORT, () => {
  console.log(`✅ running: http://localhost:${PORT}`);
});
