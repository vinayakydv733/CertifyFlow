import "dotenv/config";
import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response } from "express";
import { google } from "googleapis";
import { createClient, type User } from "@supabase/supabase-js";
import { z } from "zod";

const env = z.object({
  APP_URL: z.string().url(),
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  GOOGLE_REDIRECT_URI: z.string().url(),
  TOKEN_ENCRYPTION_KEY: z.string().min(43),
  OAUTH_STATE_SECRET: z.string().min(32),
}).parse(process.env);

const app = express();
const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const campaignSchema = z.object({ name: z.string().trim().min(1).max(120), organizationName: z.string().trim().min(1).max(160), description: z.string().trim().max(500).optional() });

app.use(express.json({ limit: "1mb" }));
app.disable("x-powered-by");

type AuthenticatedRequest = Request & { user: User };
async function requireUser(req: Request, res: Response, next: NextFunction) {
  const token = req.header("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return res.status(401).json({ error: "Authentication required." });
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return res.status(401).json({ error: "Your session is invalid or expired." });
  (req as AuthenticatedRequest).user = data.user;
  next();
}

app.get("/api/health", (_req, res) => res.json({ ok: true }));
app.get("/api/campaigns", requireUser, async (req, res) => {
  const { data, error } = await supabase.from("campaigns").select("id,name,organization_name,description,status,updated_at").eq("user_id", (req as AuthenticatedRequest).user.id).order("updated_at", { ascending: false });
  if (error) return res.status(500).json({ error: "Could not load campaigns." });
  res.json({ campaigns: data });
});
app.post("/api/campaigns", requireUser, async (req, res) => {
  const parsed = campaignSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: "Please provide a campaign name and organization name." });
  const { data, error } = await supabase.from("campaigns").insert({ user_id: (req as AuthenticatedRequest).user.id, name: parsed.data.name, organization_name: parsed.data.organizationName, description: parsed.data.description || null }).select("id,name,organization_name,description,status,updated_at").single();
  if (error) return res.status(500).json({ error: "Could not create the campaign." });
  res.status(201).json({ campaign: data });
});

app.post("/api/gmail/connect", requireUser, (req, res) => {
  const state = signState((req as AuthenticatedRequest).user.id);
  const oauth = newOAuthClient();
  const url = oauth.generateAuthUrl({ access_type: "offline", prompt: "consent", state, scope: ["openid", "email", "https://www.googleapis.com/auth/gmail.send"] });
  res.json({ url });
});
app.get("/api/gmail/callback", async (req, res) => {
  const code = typeof req.query.code === "string" ? req.query.code : ""; const state = typeof req.query.state === "string" ? req.query.state : "";
  const userId = verifyState(state); if (!code || !userId) return res.redirect(`${env.APP_URL}/?gmail=failed`);
  try {
    const oauth = newOAuthClient(); const { tokens } = await oauth.getToken(code); if (!tokens.refresh_token) throw new Error("Missing refresh token"); oauth.setCredentials(tokens);
    const profile = await google.oauth2("v2").userinfo.get({ auth: oauth }); const gmailAddress = profile.data.email;
    if (!gmailAddress) throw new Error("Missing account email");
    const { error } = await supabase.from("email_connections").upsert({ user_id: userId, gmail_address: gmailAddress, encrypted_refresh_token: encrypt(tokens.refresh_token), scopes: ["https://www.googleapis.com/auth/gmail.send"], revoked_at: null }, { onConflict: "user_id" });
    if (error) throw error; res.redirect(`${env.APP_URL}/?gmail=connected`);
  } catch { res.redirect(`${env.APP_URL}/?gmail=failed`); }
});
app.delete("/api/gmail/connection", requireUser, async (req, res) => {
  const { error } = await supabase.from("email_connections").update({ revoked_at: new Date().toISOString(), encrypted_refresh_token: "" }).eq("user_id", (req as AuthenticatedRequest).user.id);
  if (error) return res.status(500).json({ error: "Could not disconnect Gmail." }); res.status(204).end();
});

app.use((_req, res) => res.status(404).json({ error: "Not found." }));
app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => { console.error(error); res.status(500).json({ error: "Something went wrong. Please try again." }); });
app.listen(Number(process.env.PORT || 8787), "127.0.0.1", () => console.log("API listening on http://127.0.0.1:8787"));

function newOAuthClient() { return new google.auth.OAuth2(env.GOOGLE_CLIENT_ID, env.GOOGLE_CLIENT_SECRET, env.GOOGLE_REDIRECT_URI); }
function signState(userId: string) { const payload = Buffer.from(JSON.stringify({ userId, exp: Date.now() + 10 * 60_000, nonce: randomBytes(16).toString("hex") })).toString("base64url"); return `${payload}.${createHmac("sha256", env.OAUTH_STATE_SECRET).update(payload).digest("base64url")}`; }
function verifyState(state: string) { const [payload, signature] = state.split("."); if (!payload || !signature) return null; const expected = createHmac("sha256", env.OAUTH_STATE_SECRET).update(payload).digest("base64url"); if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null; try { const data = JSON.parse(Buffer.from(payload, "base64url").toString()) as { userId: string; exp: number }; return data.exp > Date.now() ? data.userId : null; } catch { return null; } }
function encrypt(value: string) { const key = Buffer.from(env.TOKEN_ENCRYPTION_KEY, "base64"); const iv = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key, iv); const encrypted = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]); return `${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`; }
export function decrypt(value: string) { const [iv, tag, encrypted] = value.split("."); const decipher = createDecipheriv("aes-256-gcm", Buffer.from(env.TOKEN_ENCRYPTION_KEY, "base64"), Buffer.from(iv, "base64url")); decipher.setAuthTag(Buffer.from(tag, "base64url")); return Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8"); }
