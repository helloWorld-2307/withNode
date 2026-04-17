process.stdout.setEncoding("utf8");

import Groq from "groq-sdk";
import dotenv from "dotenv";
import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSessionStore } from "./sessionStore.js";
import cors from "cors";
import express from "express";
const app = express();

app.use(cors({
  origin: 'https://with-node-vc7s.vercel.app', // Sirf apne Vercel link ko allow karo
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  credentials: true
}));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env"), override: true });

function assertEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing ${name}. Put it in .env (example: ${name}=...) and re-run.`
    );
  }
  return value;
}

const client = new Groq({ apiKey: assertEnv("GROQ_API_KEY") });

const DEFAULT_MODEL = "llama-3.1-8b-instant";
const DEFAULT_SYSTEM = `
You are an empathetic and professional AI assistant, like ChatGPT. 
Your goal is to understand the user's emotions and provide structured, beautiful responses.

FORMATTING RULES:
1. EMOJIS: Use relevant emojis at the start of headings and to express empathy.
2. STRUCTURE: Use '###' for clear, bold headings. 
3. BOLDING: Use **Bold** for key concepts and importance.
4. SPACING: Always add a blank line between sections.
5. LISTS: Use numbered lists (1, 2, 3) for steps and bullet points (•) for ideas.
6. TONE: Be warm, supportive, and understanding. 

Example:
### 🌿 Finding Your Inner Peace
Managing stress is a journey, and I'm here to support you. **You're not alone.**
1. **Breathe Deeply**: Inhale for 4 seconds...
`.trim();

function newSessionId() {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const rand = crypto.randomBytes(4).toString("hex");
  return `${ts}-${rand}`;
}

function createNewSession({ model, systemPrompt }) {
  const id = newSessionId();
  const now = new Date().toISOString();
  return {
    id,
    createdAt: now,
    updatedAt: now,
    model,
    systemPrompt,
    messages: [{ role: "system", content: systemPrompt, createdAt: now }],
  };
}

function json(res, statusCode, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(payload);
}

function text(res, statusCode, body, extraHeaders = {}) {
  res.writeHead(statusCode, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
    ...extraHeaders,
  });
  res.end(body);
}

function corsHeaders(req) {
  const defaultOrigin = "http://localhost:3000";
  const origin = process.env.CORS_ORIGIN?.trim() || defaultOrigin;
  const reqOrigin = req.headers.origin;

  if (origin === "*") {
    return { "Access-Control-Allow-Origin": "*" };
  }

  if (reqOrigin && reqOrigin === origin) {
    return { "Access-Control-Allow-Origin": origin, Vary: "Origin" };
  }

  // non-browser / same-origin / unknown origin: don't block, but also don't open CORS
  return {};
}

async function readJson(req) {
  const chunks = [];
  let total = 0;
  const limit = 1_000_000; // ~1MB

  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw new Error("Request body too large");
    chunks.push(chunk);
  }

  if (chunks.length === 0) return {};

  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Invalid JSON body");
  }
}

async function startServer() {
  const store = await createSessionStore();

  let cleanedUp = false;
  async function cleanup() {
    if (cleanedUp) return;
    cleanedUp = true;
    try {
      await store.close();
    } catch {}
  }

  process.once("SIGINT", async () => {
    await cleanup();
    process.exitCode = 130;
  });

  process.once("SIGTERM", async () => {
    await cleanup();
    process.exitCode = 143;
  });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    const method = (req.method || "GET").toUpperCase();

    const cors = corsHeaders(req);

    if (method === "OPTIONS") {
      res.writeHead(204, {
        ...cors,
        "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "86400",
      });
      res.end();
      return;
    }

    try {
      if (method === "GET" && url.pathname === "/health") {
        json(
          res,
          200,
          { ok: true, message: "Backend running", store: store.kind, time: new Date().toISOString() },
          cors
        );
        return;
      }

      if (method === "GET" && url.pathname === "/sessions") {
        const sessions = await store.list();
        json(res, 200, { sessions }, cors);
        return;
      }

      const sessionMatch = url.pathname.match(/^\/sessions\/([^/]+)$/);
      if (method === "GET" && sessionMatch) {
        const id = decodeURIComponent(sessionMatch[1]);
        try {
          const session = await store.load(id);
          json(res, 200, { session }, cors);
        } catch (err) {
          json(res, 404, { error: err?.message ?? "Not found" }, cors);
        }
        return;
      }

      if (method === "DELETE" && sessionMatch) {
        const id = decodeURIComponent(sessionMatch[1]);
        const result = await store.delete(id);
        json(res, 200, { ok: true, ...result }, cors);
        return;
      }

      if (method === "DELETE" && url.pathname === "/sessions") {
        const result = await store.clear();
        json(res, 200, { ok: true, ...result }, cors);
        return;
      }

      if (method === "POST" && url.pathname === "/sessions") {
        const body = await readJson(req).catch(() => ({}));
        const session = createNewSession({
          model: body.model || DEFAULT_MODEL,
          systemPrompt: body.systemPrompt || DEFAULT_SYSTEM,
        });
        await store.save(session);
        json(res, 200, { sessionId: session.id }, cors);
        return;
      }

      if (method === "POST" && url.pathname === "/chat") {
        const body = await readJson(req);
        const message = (body.message ?? "").trim();
        if (!message) {
          json(res, 400, { error: "Missing message" }, cors);
          return;
        }

        const session = body.sessionId
          ? await store.load(body.sessionId)
          : createNewSession({
              model: body.model || DEFAULT_MODEL,
              systemPrompt: body.systemPrompt || DEFAULT_SYSTEM,
            });

        if (body.model) session.model = body.model;

        if (body.systemPrompt && body.systemPrompt !== session.systemPrompt) {
          session.systemPrompt = body.systemPrompt;
          const now = new Date().toISOString();
          session.messages = [
            { role: "system", content: session.systemPrompt, createdAt: now },
          ];
        }

        const now = new Date().toISOString();
        session.messages.push({ role: "user", content: message, createdAt: now });
        await store.save(session);

        res.writeHead(200, {
          ...cors,
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
          "x-session-id": session.id,
        });

        let assistantText = "";
        try {
          const groqStream = await client.chat.completions.create({
            model: session.model || DEFAULT_MODEL,
            messages: session.messages.map((m) => ({
              role: m.role,
              content: m.content,
            })),
            stream: true,
          });

          for await (const chunk of groqStream) {
            const delta = chunk?.choices?.[0]?.delta?.content ?? "";
            if (!delta) continue;
            assistantText += delta;
            res.write(delta);
          }

          const ts = new Date().toISOString();
          session.messages.push({
            role: "assistant",
            content: assistantText,
            createdAt: ts,
          });

          if (!session.title) {
            session.title =
              message.length > 60 ? message.slice(0, 57).trimEnd() + "..." : message;
          }

          session.updatedAt = ts;
          await store.save(session);
        } catch (err) {
          res.write(`\n\n[Error] ${err?.message ?? String(err)}\n`);
        } finally {
          res.end();
        }
        return;
      }

      text(res, 404, "Not found", cors);
    } catch (err) {
      json(res, 500, { error: err?.message ?? String(err) }, cors);
    }
  });

  const port = Number(process.env.PORT) || 4000;
  server.listen(port, () => {
    console.log(`Backend running at http://localhost:${port}`);
    console.log(`Storage: ${store.kind}`);
  });
}

startServer().catch((err) => {
  console.error(err?.message ?? err);
  process.exitCode = 1;
});
