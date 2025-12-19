import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { nanoid } from "nanoid";
import pg from "pg";

const { Pool } = pg;

const ADMIN_KEY = process.env.ADMIN_KEY || ""; // Koyeb 환경변수로 넣을 값

function isAdmin(req) {
  // 헤더로 받은 관리자키가 서버의 ADMIN_KEY와 같으면 관리자
  return ADMIN_KEY && req.get("x-admin-key") === ADMIN_KEY;
}

const app = express();
app.set("trust proxy", 1); // Koyeb(리버스프록시) 환경에서 req.secure 판단용
app.use(express.json({ limit: "1mb" }));

// __dirname (ESM)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 정적 파일 (public/index.html, css, js 등)
app.use(express.static(path.join(__dirname, "public")));

// --------------------
// Cookie / Token
// --------------------
function parseCookies(cookieHeader = "") {
  const out = {};
  cookieHeader.split(";").forEach((part) => {
    const [k, ...rest] = part.trim().split("=");
    if (!k) return;
    out[k] = decodeURIComponent(rest.join("=") || "");
  });
  return out;
}

app.use((req, res, next) => {
  const cookies = parseCookies(req.headers.cookie || "");
  let token = cookies.party_token;

  if (!token) {
    token = nanoid(16);

    // https 환경이면 Secure 붙이기
    const isHttps =
      req.secure || (req.headers["x-forwarded-proto"] || "").includes("https");

    const parts = [
      `party_token=${encodeURIComponent(token)}`,
      "Path=/",
      `Max-Age=${60 * 60 * 24 * 365}`,
      "SameSite=Lax",
      "HttpOnly",
    ];
    if (isHttps) parts.push("Secure");

    res.setHeader("Set-Cookie", parts.join("; "));
  }

  req.partyToken = token;
  next();
});

// --------------------
// DB (Supabase/Postgres)
// --------------------
let pool = null;
let lastDbError = null;
let schemaInitPromise = null;

function getPoolOrNull() {
  if (!process.env.DATABASE_URL) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false }, // Supabase용
    });
  }
  return pool;
}

async function ensureSchema() {
  const p = getPoolOrNull();
  if (!p) throw new Error("DATABASE_URL env is required");

  await p.query(`
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

  await p.query(`
    create table if not exists public.participants (
      id bigserial primary key,
      room_id text not null references public.rooms(id) on delete cascade,
      namejob text not null,
      token text not null,
      created_at timestamptz not null default now()
    );
  `);

  await p.query(`
    create unique index if not exists idx_participants_room_token
      on public.participants(room_id, token);
  `);

  await p.query(`
    create index if not exists idx_rooms_created_at
      on public.rooms(created_at desc);
  `);

  await p.query(`
    create index if not exists idx_participants_room_id
      on public.participants(room_id);
  `);
}

// schema init을 “서버가 죽지 않게” 지연/재시도 가능하게
async function ensureDbReady() {
  const p = getPoolOrNull();
  if (!p) {
    lastDbError = new Error("DATABASE_URL env is required");
    throw lastDbError;
  }

  if (!schemaInitPromise) {
    schemaInitPromise = ensureSchema()
      .then(() => {
        lastDbError = null;
      })
      .catch((err) => {
        lastDbError = err;
        schemaInitPromise = null; // 다음 요청 때 재시도 가능
        throw err;
      });
  }

  return schemaInitPromise;
}

// --------------------
// Helpers
// --------------------
const ah = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// DB 필요한 라우트는 이 래퍼로 감싸기 (DB 안 되면 503으로)
const ahDb = (fn) =>
  ah(async (req, res, next) => {
    try {
      await ensureDbReady();
    } catch (e) {
      return res.status(503).json({
        ok: false,
        error: "DB_UNAVAILABLE",
        message:
          "DB 연결이 안 돼서 기능을 사용할 수 없어. (DATABASE_URL 또는 비밀번호/권한 문제)",
      });
    }
    return fn(req, res, next);
  });

async function getRoomOne(roomId, myToken) {
  const p = getPoolOrNull();
  const roomRes = await p.query(`select * from public.rooms where id = $1`, [
    roomId,
  ]);
  if (roomRes.rowCount === 0) return null;
  const room = roomRes.rows[0];

  const pRes = await p.query(
    `select id, room_id, namejob, token, created_at
     from public.participants
     where room_id = $1
     order by id asc`,
    [roomId]
  );

  const participants = pRes.rows.map((x) => ({
    id: x.id,
    namejob: x.namejob,
    created_at: x.created_at,
    isMe: x.token === myToken,
  }));

  const count = participants.length;

  return {
    ...room,
    participants,
    joined: participants.some((x) => x.isMe),
    isHost: room.host_token === myToken,
    count,
    isFull: count >= room.capacity,
  };
}

async function getRoomsAll(myToken) {
  const p = getPoolOrNull();
  const roomsRes = await p.query(
    `select * from public.rooms order by created_at desc`
  );
  const rooms = roomsRes.rows;
  if (rooms.length === 0) return [];

  const ids = rooms.map((r) => r.id);

  const pRes = await p.query(
    `select id, room_id, namejob, token, created_at
     from public.participants
     where room_id = any($1::text[])
     order by id asc`,
    [ids]
  );

  const byRoom = new Map();
  for (const row of pRes.rows) {
    if (!byRoom.has(row.room_id)) byRoom.set(row.room_id, []);
    byRoom.get(row.room_id).push({
      id: row.id,
      namejob: row.namejob,
      created_at: row.created_at,
      isMe: row.token === myToken,
    });
  }

  return rooms.map((r) => {
    const list = byRoom.get(r.id) || [];
    const count = list.length;
    return {
      ...r,
      participants: list,
      joined: list.some((x) => x.isMe),
      isHost: r.host_token === myToken,
      count,
      isFull: count >= r.capacity,
    };
  });
}

// --------------------
// API
// --------------------

// 헬스체크: Koyeb 확인용 + DB 상태도 같이 보여줌
app.get(
  "/api/health",
  ah(async (req, res) => {
    const hasUrl = !!process.env.DATABASE_URL;
    res.status(200).json({
      ok: true,
      hasDatabaseUrl: hasUrl,
      dbReady: hasUrl && !lastDbError,
      dbError: lastDbError ? String(lastDbError.message || lastDbError) : null,
    });
  })
);

// 전체 방 목록
app.get(
  "/api/rooms",
  ahDb(async (req, res) => {
    const data = await getRoomsAll(req.partyToken);
    res.json(data);
  })
);

// 단일 방 조회
app.get(
  "/api/rooms/:id",
  ahDb(async (req, res) => {
    const room = await getRoomOne(req.params.id, req.partyToken);
    if (!room) return res.status(404).json({ message: "방을 찾을 수 없어." });
    res.json(room);
  })
);

// 방 만들기
app.post(
  "/api/rooms",
  ahDb(async (req, res) => {
    const dungeon = String(req.body?.dungeon ?? "").trim();
    const host = String(req.body?.host ?? "").trim();
    const time = String(req.body?.time ?? "").trim();
    const capacity = Math.floor(Number(req.body?.capacity ?? 4));

    if (!dungeon || !host || !time) {
      return res
        .status(400)
        .json({ message: "던전/시간/닉네임·직업을 모두 입력해줘." });
    }
    if (!Number.isFinite(capacity) || capacity < 2 || capacity > 20) {
      return res
        .status(400)
        .json({ message: "정원은 2~20 사이로 입력해줘." });
    }

    const id = nanoid(10);
    const hostToken = req.partyToken;
    const p = getPoolOrNull();

    await p.query(
      `insert into public.rooms (id, dungeon, time, capacity, host, host_token)
       values ($1, $2, $3, $4, $5, $6)`,
      [id, dungeon, time, capacity, host, hostToken]
    );

    // 방장은 자동 참가
    await p.query(
      `insert into public.participants (room_id, namejob, token)
       values ($1, $2, $3)`,
      [id, `${host} (방장)`, hostToken]
    );

    res.json({ id });
  })
);

// 참가
app.post(
  "/api/rooms/:id/join",
  ahDb(async (req, res) => {
    const roomId = req.params.id;
    const namejob = String(req.body?.namejob ?? "").trim();
    if (!namejob)
      return res.status(400).json({ message: "닉네임/직업을 입력해줘." });

    const room = await getRoomOne(roomId, req.partyToken);
    if (!room) return res.status(404).json({ message: "방을 찾을 수 없어." });
    if (room.isFull) return res.status(409).json({ message: "정원이 꽉 찼어." });
    if (room.joined)
      return res.status(409).json({ message: "이미 이 방에 참가(예약)했어." });

    const p = getPoolOrNull();

    try {
      await p.query(
        `insert into public.participants (room_id, namejob, token)
         values ($1, $2, $3)`,
        [roomId, namejob, req.partyToken]
      );
    } catch {
      return res.status(409).json({ message: "이미 이 방에 참가(예약)했어." });
    }

    res.json({ ok: true });
  })
);

// 참가 취소
app.post(
  "/api/rooms/:id/leave",
  ahDb(async (req, res) => {
    const roomId = req.params.id;
    const room = await getRoomOne(roomId, req.partyToken);
    if (!room) return res.status(404).json({ message: "방을 찾을 수 없어." });
    if (room.isHost)
      return res
        .status(400)
        .json({ message: "방장은 예약 취소 대신 방 삭제를 이용해줘." });

    const p = getPoolOrNull();

    const del = await p.query(
      `delete from public.participants
       where room_id = $1 and token = $2`,
      [roomId, req.partyToken]
    );

    if (del.rowCount === 0)
      return res.status(409).json({ message: "이 방에 참가 중이 아니야." });

    res.json({ ok: true });
  })
);

// ✅ 방 삭제: 방장이면 OK / 방장이 아니면 관리자키 있으면 OK
app.delete(
  "/api/rooms/:id",
  ahDb(async (req, res) => {
    const roomId = req.params.id;
    const p = getPoolOrNull();

    const roomRes = await p.query(
      `select host_token from public.rooms where id = $1`,
      [roomId]
    );
    if (roomRes.rowCount === 0)
      return res.status(404).json({ message: "방을 찾을 수 없어." });

    const isHost = roomRes.rows[0].host_token === req.partyToken;

    if (!isHost && !isAdmin(req)) {
      return res.status(403).json({ message: "방장만 삭제할 수 있어. (또는 관리자 키 필요)" });
    }

    await p.query(`delete from public.rooms where id = $1`, [roomId]);
    res.json({ ok: true });
  })
);

// 공유링크도 프론트 보여주기
app.get("/r/:id", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// SPA 새로고침 404 방지: /api/* 제외하고 전부 index.html
app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// 에러 핸들러
app.use((err, req, res, next) => {
  console.error("❌ API Error:", err);
  res.status(500).json({ ok: false, error: "SERVER_ERROR" });
});

// --------------------
// Listen (한 번만)
// --------------------
const PORT = Number(process.env.PORT) || 8000;
app.listen(PORT, "0.0.0.0", () => {
  console.log("✅ Server running on", PORT);
});

// 서버 뜨자마자 schema init 한 번 시도(실패해도 서버는 살아있음)
ensureDbReady().then(
  () => console.log("✅ DB schema ready"),
  (e) => console.error("❌ DB init failed:", e?.message || e)
);
