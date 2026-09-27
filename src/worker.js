const MAX_IMAGE = 10 * 1024 * 1024;
const MAX_VIDEO = 100 * 1024 * 1024;
const SESSION_TTL = 30 * 24 * 60 * 60;

const IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp"
]);

const VIDEO_TYPES = new Set([
  "video/mp4",
  "video/webm",
  "video/ogg"
]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    try {
      // Вход
      if (url.pathname === "/api/login" && request.method === "POST") {
        return await login(request, env);
      }

      // Выход
      if (url.pathname === "/api/logout" && request.method === "POST") {
        return new Response(null, {
          status: 204,
          headers: {
            "Set-Cookie": clearCookie()
          }
        });
      }

      // Проверка авторизации
      if (url.pathname === "/api/me" && request.method === "GET") {
        return json({
          loggedIn: await isAuthed(request, env)
        });
      }

      // Получить все записи
      if (url.pathname === "/api/posts" && request.method === "GET") {
        const { results } = await env.DB.prepare(
          `SELECT id, body, created_at, media_key, media_type, original_name
           FROM posts
           ORDER BY created_at DESC, id DESC`
        ).all();

        return json(
          results.map((post) => ({
            id: post.id,
            body: post.body,
            createdAt: post.created_at,
            mediaUrl: post.media_key
              ? `/media/${encodeURIComponent(post.media_key)}`
              : null,
            mediaType: post.media_type,
            originalName: post.original_name
          }))
        );
      }

      // Создать запись
      if (url.pathname === "/api/posts" && request.method === "POST") {
        if (!(await isAuthed(request, env))) {
          return json({ error: "Не авторизован" }, 401);
        }

        return await createPost(request, env);
      }

      // Удалить запись
      const deleteMatch = url.pathname.match(/^\/api\/posts\/(\d+)$/);

      if (deleteMatch && request.method === "DELETE") {
        if (!(await isAuthed(request, env))) {
          return json({ error: "Не авторизован" }, 401);
        }

        return await deletePost(Number(deleteMatch[1]), env);
      }

      // Получить медиафайл
      if (url.pathname.startsWith("/media/") && request.method === "GET") {
        const key = decodeURIComponent(
          url.pathname.slice("/media/".length)
        );

        if (!key || key.includes("..") || key.includes("/")) {
          return new Response("Not found", { status: 404 });
        }

        const object = await env.MEDIA.get(key);

        if (!object) {
          return new Response("Not found", { status: 404 });
        }

        const headers = new Headers();

        object.writeHttpMetadata(headers);
        headers.set(
          "Cache-Control",
          "public, max-age=31536000, immutable"
        );

        return new Response(object.body, { headers });
      }

      // Всё остальное — обычные HTML-файлы сайта
      if (url.pathname === "/" || url.pathname === "/index.html") {
        return env.ASSETS.fetch(
          new Request(new URL("/index.html", request.url), request)
        );
      }

      if (url.pathname === "/admin" || url.pathname === "/admin/") {
        return env.ASSETS.fetch(
          new Request(new URL("/admin.html", request.url), request)
        );
      }

      return env.ASSETS.fetch(request);

    } catch (error) {
      console.error(error);
      return json({ error: "Ошибка сервера" }, 500);
    }
  }
};


// ============================
// ВХОД
// ============================

async function login(request, env) {
  let data;

  try {
    data = await request.json();
  } catch {
    return json({ error: "Неверный JSON" }, 400);
  }

  const username = String(data.username || "");
  const password = String(data.password || "");

  const correctUsername = env.ADMIN_USER || "Lenivec";

  if (
    username !== correctUsername ||
    !env.ADMIN_PASSWORD ||
    password !== env.ADMIN_PASSWORD
  ) {
    return json({ error: "Неверный логин или пароль" }, 401);
  }

  const timestamp = Math.floor(Date.now() / 1000);

  const signature = await hmac(
    `${correctUsername}:${timestamp}`,
    env.ADMIN_PASSWORD
  );

  const token = `${timestamp}.${signature}`;

  return json(
    { ok: true },
    200,
    {
      "Set-Cookie":
        `lenivec_session=${token}; ` +
        `Path=/; ` +
        `HttpOnly; ` +
        `Secure; ` +
        `SameSite=Strict; ` +
        `Max-Age=${SESSION_TTL}`
    }
  );
}


// ============================
// СОЗДАНИЕ ЗАПИСИ
// ============================

async function createPost(request, env) {
  const form = await request.formData();

  const body = String(form.get("body") || "").trim();
  const file = form.get("file");

  if (!body && !(file instanceof File)) {
    return json(
      { error: "Нужен текст или файл" },
      400
    );
  }

  if (body.length > 20000) {
    return json(
      { error: "Текст слишком длинный" },
      400
    );
  }

  let mediaKey = null;
  let mediaType = null;
  let originalName = null;

  if (file instanceof File && file.size > 0) {
    const type = file.type.toLowerCase();

    if (
      !IMAGE_TYPES.has(type) &&
      !VIDEO_TYPES.has(type)
    ) {
      return json(
        { error: "Разрешены только изображения и видео" },
        400
      );
    }

    const isVideo = VIDEO_TYPES.has(type);
    const maxSize = isVideo
      ? MAX_VIDEO
      : MAX_IMAGE;

    if (file.size > maxSize) {
      return json(
        {
          error:
            `Файл слишком большой. Максимум: ` +
            `${isVideo ? "100 MB" : "10 MB"}`
        },
        400
      );
    }

    if (!(await looksLikeAllowedFile(file, type))) {
      return json(
        { error: "Файл не похож на заявленный тип" },
        400
      );
    }

    const extension = extensionFor(type);

    mediaKey =
      `${crypto.randomUUID()}${extension}`;

    mediaType = isVideo
      ? "video"
      : "image";

    originalName =
      safeName(file.name).slice(0, 180);

    await env.MEDIA.put(
      mediaKey,
      file.stream(),
      {
        httpMetadata: {
          contentType: type,
          contentDisposition:
            `inline; filename="${originalName.replace(/"/g, "")}"`
        }
      }
    );
  }

  const now = Date.now();

  const result = await env.DB.prepare(
    `INSERT INTO posts
     (body, created_at, media_key, media_type, original_name)
     VALUES (?, ?, ?, ?, ?)`
  )
    .bind(
      body,
      now,
      mediaKey,
      mediaType,
      originalName
    )
    .run();

  return json(
    {
      ok: true,
      id: result.meta.last_row_id
    },
    201
  );
}


// ============================
// УДАЛЕНИЕ
// ============================

async function deletePost(id, env) {
  const post = await env.DB.prepare(
    "SELECT media_key FROM posts WHERE id = ?"
  )
    .bind(id)
    .first();

  if (!post) {
    return json(
      { error: "Запись не найдена" },
      404
    );
  }

  await env.DB.prepare(
    "DELETE FROM posts WHERE id = ?"
  )
    .bind(id)
    .run();

  if (post.media_key) {
    await env.MEDIA.delete(post.media_key);
  }

  return json({ ok: true });
}


// ============================
// ПРОВЕРКА АВТОРИЗАЦИИ
// ============================

async function isAuthed(request, env) {
  const cookie =
    request.headers.get("Cookie") || "";

  const match = cookie.match(
    /(?:^|;\s*)lenivec_session=([^;]+)/
  );

  if (!match || !env.ADMIN_PASSWORD) {
    return false;
  }

  const parts = match[1].split(".");

  if (parts.length !== 2) {
    return false;
  }

  const timestamp = Number(parts[0]);

  if (!Number.isFinite(timestamp)) {
    return false;
  }

  const current =
    Math.floor(Date.now() / 1000);

  if (
    Math.abs(current - timestamp) >
    SESSION_TTL
  ) {
    return false;
  }

  const username =
    env.ADMIN_USER || "Lenivec";

  const expected =
    await hmac(
      `${username}:${timestamp}`,
      env.ADMIN_PASSWORD
    );

  return timingSafeEqual(
    parts[1],
    expected
  );
}


// ============================
// HMAC
// ============================

async function hmac(message, secret) {
  const key =
    await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      {
        name: "HMAC",
        hash: "SHA-256"
      },
      false,
      ["sign"]
    );

  const signature =
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(message)
    );

  return [...new Uint8Array(signature)]
    .map(
      (byte) =>
        byte.toString(16).padStart(2, "0")
    )
    .join("");
}


// ============================
// СРАВНЕНИЕ СИГНАТУР
// ============================

function timingSafeEqual(a, b) {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;

  for (let i = 0; i < a.length; i++) {
    result |=
      a.charCodeAt(i) ^
      b.charCodeAt(i);
  }

  return result === 0;
}


// ============================
// УДАЛЕНИЕ COOKIE
// ============================

function clearCookie() {
  return (
    "lenivec_session=; " +
    "Path=/; " +
    "HttpOnly; " +
    "Secure; " +
    "SameSite=Strict; " +
    "Max-Age=0"
  );
}


// ============================
// JSON
// ============================

function json(
  data,
  status = 200,
  extraHeaders = {}
) {
  const headers = new Headers({
    "Content-Type":
      "application/json; charset=utf-8",

    "Cache-Control": "no-store",

    ...extraHeaders
  });

  return new Response(
    JSON.stringify(data),
    {
      status,
      headers
    }
  );
}


// ============================
// РАСШИРЕНИЯ
// ============================

function extensionFor(type) {
  return {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",

    "video/mp4": ".mp4",
    "video/webm": ".webm",
    "video/ogg": ".ogv"
  }[type] || "";
}


// ============================
// БЕЗОПАСНОЕ ИМЯ ФАЙЛА
// ============================

function safeName(name) {
  return String(name || "file")
    .replace(/[^\w.\-() ]+/g, "_");
}


// ============================
// ПРОВЕРКА СОДЕРЖИМОГО ФАЙЛА
// ============================

async function looksLikeAllowedFile(file, type) {
  const bytes =
    new Uint8Array(
      await file
        .slice(0, 16)
        .arrayBuffer()
    );

  if (type === "image/jpeg") {
    return (
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff
    );
  }

  if (type === "image/png") {
    return (
      bytes.slice(0, 8).join(",") ===
      "137,80,78,71,13,10,26,10"
    );
  }

  if (type === "image/gif") {
    const text =
      new TextDecoder().decode(
        bytes.slice(0, 6)
      );

    return (
      text === "GIF87a" ||
      text === "GIF89a"
    );
  }

  if (type === "image/webp") {
    const riff =
      new TextDecoder().decode(
        bytes.slice(0, 4)
      );

    const webp =
      new TextDecoder().decode(
        bytes.slice(8, 12)
      );

    return (
      riff === "RIFF" &&
      webp === "WEBP"
    );
  }

  if (type === "video/webm") {
    return (
      bytes.slice(0, 4).join(",") ===
      "26,69,223,163"
    );
  }

  if (type === "video/ogg") {
    return (
      new TextDecoder().decode(
        bytes.slice(0, 4)
      ) === "OggS"
    );
  }

  if (type === "video/mp4") {
    return (
      new TextDecoder().decode(
        bytes.slice(4, 8)
      ) === "ftyp"
    );
  }

  return false;
}


