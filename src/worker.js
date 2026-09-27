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

      // Публичный просмотрщик: посты отдаются готовым HTML.
      if (url.pathname === "/viewer" || url.pathname === "/viewer/") {
        return await viewerPage(request, env);
      }

      // Простая публичная страница для внешнего просмотра.
      if (url.pathname === "/chat" || url.pathname === "/chat/") {
        return await viewerPage(request, env);
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
 // ПУБЛИЧНЫЙ ПРОСМОТР ПОСТОВ
 // ============================

 async function viewerPage(request, env) {
   const url = new URL(request.url);
   const id = url.searchParams.get("id");
   let results;

   if (id !== null) {
     if (!/^\d+$/.test(id)) {
       return new Response(renderViewerHtml([], true), {
         status: 404,
         headers: {
           "Content-Type": "text/html; charset=utf-8",
           "Cache-Control": "no-store"
         }
       });
     }

     const result = await env.DB.prepare(
       `SELECT id, body, created_at, media_key, media_type, original_name
        FROM posts
        WHERE id = ?
        LIMIT 1`
     ).bind(Number(id)).all();

     results = result.results;
   } else {
     const result = await env.DB.prepare(
       `SELECT id, body, created_at, media_key, media_type, original_name
        FROM posts
        ORDER BY created_at DESC, id DESC`
     ).all();

     results = result.results;
   }

   if (id !== null && results.length === 0) {
     return new Response(renderViewerHtml([], true), {
       status: 404,
       headers: {
         "Content-Type": "text/html; charset=utf-8",
         "Cache-Control": "no-store"
       }
     });
   }

   return new Response(renderViewerHtml(results, id !== null), {
     headers: {
       "Content-Type": "text/html; charset=utf-8",
       "Cache-Control": "no-store"
     }
   });
 }

 function renderViewerHtml(posts, single) {
   const cards = posts.map((post) => {
     const id = Number(post.id);
     const timestamp = Number(post.created_at);
     const dateText = Number.isFinite(timestamp)
       ? new Date(timestamp).toLocaleString("ru-RU")
       : "";

     const postUrl = "/viewer?id=" + encodeURIComponent(id);
     const mediaUrl = post.media_key
       ? "/media/" + encodeURIComponent(post.media_key)
       : "";

     let media = "";

     if (mediaUrl && post.media_type === "image") {
       media = '<img src="' + escapeHtml(mediaUrl) +
         '" alt="" loading="lazy">';
     } else if (mediaUrl && post.media_type === "video") {
       media = '<video src="' + escapeHtml(mediaUrl) +
         '" controls preload="metadata"></video>';
     }

     return [
       '<article class="post">',
       '<div class="date">', escapeHtml(dateText), '</div>',
       '<div class="author">Опубликовал: Lenivec</div>',
       '<div class="text">', escapeHtml(post.body || ""), '</div>',
       media,
       '<div class="actions">',
       '<button class="share" data-url="', escapeHtml(postUrl), '">Поделиться</button>',
       single
         ? '<a href="/viewer">Все посты</a>'
         : '<a href="' + escapeHtml(postUrl) + '">Открыть отдельно</a>',
       '</div>',
       '</article>'
     ].join("");
   }).join("");

   const content = cards ||
     '<article class="post"><div class="text">Пост не найден</div></article>';

   return `<!doctype html>
 <html lang="ru">
 <head>
 <meta charset="utf-8">
 <meta name="viewport" content="width=device-width,initial-scale=1">
 <title>Lenivec</title>
 <style>
 body{font-family:Arial,sans-serif;background:#eee;color:#222;margin:0;padding:20px}
 main{max-width:800px;margin:auto}
 h1{margin:0 0 20px}
 .post{background:#fff;padding:20px;margin-bottom:16px;border:1px solid #ddd;border-radius:5px}
 .date{color:#777;font-size:14px}
 .author{color:#555;font-size:14px;margin-top:7px}
 .text{white-space:pre-wrap;line-height:1.5;margin-top:15px}
 img,video{display:block;max-width:100%;margin-top:15px}
 video{width:100%}
 .actions{margin-top:15px}
 button,a{display:inline-block;margin-right:8px;padding:10px 16px;background:#fff;border:1px solid #999;color:#222;text-decoration:none;cursor:pointer;font:inherit}
 button:hover,a:hover{background:#eee}
 </style>
 </head>
 <body>
 <main>
 <h1>Lenivec</h1>
 ${content}
 </main>
 <script>
 document.querySelectorAll(".share").forEach((button) => {
   button.addEventListener("click", async () => {
     const shareUrl = new URL(button.dataset.url, location.origin).href;
     try {
       if (navigator.share) {
         await navigator.share({title:"Lenivec", url:shareUrl});
       } else {
         await navigator.clipboard.writeText(shareUrl);
         button.textContent = "Ссылка скопирована!";
         setTimeout(() => {
           button.textContent = "Поделиться";
         }, 2000);
       }
     } catch (error) {}
   });
 });
 </script>
 </body>
 </html>`;
 }

 function escapeHtml(value) {
   return String(value)
     .replace(/&/g, "&amp;")
     .replace(/</g, "&lt;")
     .replace(/>/g, "&gt;")
     .replace(/"/g, "&quot;")
     .replace(/'/g, "&#39;");
 }

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


