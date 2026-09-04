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
const recipientSchema = z.object({ name: z.string().trim().min(1).max(160), email: z.string().trim().email().max(320), college: z.string().trim().max(160).optional(), achievement: z.string().trim().max(240).optional() });
const recipientsSchema = z.object({ recipients: z.array(recipientSchema).min(1).max(10_000) });
const campaignIdSchema = z.string().uuid();

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

async function ownedCampaign(campaignId: string, userId: string) {
  if (!campaignIdSchema.safeParse(campaignId).success) return null;
  const { data } = await supabase.from("campaigns").select("id").eq("id", campaignId).eq("user_id", userId).maybeSingle();
  return data;
}
function routeParam(value: string | string[]) { return Array.isArray(value) ? value[0] || "" : value; }

app.post("/api/campaigns/:campaignId/template", requireUser, express.raw({ type: ["image/png", "image/jpeg"], limit: "10mb" }), async (req, res) => {
  const userId = (req as AuthenticatedRequest).user.id; const campaignId = routeParam(req.params.campaignId);
  if (!await ownedCampaign(campaignId, userId)) return res.status(404).json({ error: "Campaign not found." });
  const contentType = req.header("content-type") as "image/png" | "image/jpeg" | undefined; const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])); const jpeg = bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]));
  if (!contentType || bytes.length === 0 || (contentType === "image/png" && !png) || (contentType === "image/jpeg" && !jpeg)) return res.status(400).json({ error: "The uploaded file is not a valid PNG or JPG image." });
  const extension = contentType === "image/png" ? "png" : "jpg"; const storageKey = `${userId}/${campaignId}/template.${extension}`;
  const upload = await supabase.storage.from("certificate-files").upload(storageKey, bytes, { contentType, upsert: true });
  if (upload.error) return res.status(500).json({ error: "Could not store the certificate template." });
  const { data, error } = await supabase.from("templates").upsert({ campaign_id: campaignId, storage_key: storageKey, mime_type: contentType }, { onConflict: "campaign_id" }).select("id,storage_key,mime_type").single();
  if (error) return res.status(500).json({ error: "Could not save the certificate template." });
  res.status(201).json({ template: data });
});

app.get("/api/campaigns/:campaignId/recipients", requireUser, async (req, res) => {
  const userId = (req as AuthenticatedRequest).user.id; const campaignId = routeParam(req.params.campaignId); if (!await ownedCampaign(campaignId, userId)) return res.status(404).json({ error: "Campaign not found." });
  const { data, error } = await supabase.from("recipients").select("id,email,data,is_valid,validation_error").eq("campaign_id", campaignId).order("created_at");
  if (error) return res.status(500).json({ error: "Could not load recipients." }); res.json({ recipients: data });
});
app.post("/api/campaigns/:campaignId/recipients", requireUser, async (req, res) => {
  const userId = (req as AuthenticatedRequest).user.id; const campaignId = routeParam(req.params.campaignId); if (!await ownedCampaign(campaignId, userId)) return res.status(404).json({ error: "Campaign not found." });
  const parsed = recipientsSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: "Provide between 1 and 10,000 valid recipient records." });
  const seen = new Set<string>(); const rows = parsed.data.recipients.filter((recipient) => { const key = recipient.email.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; }).map((recipient) => ({ campaign_id: campaignId, email: recipient.email.toLowerCase(), data: { name: recipient.name, college: recipient.college || "", achievement: recipient.achievement || "Participant" }, is_valid: true }));
  const { data, error } = await supabase.from("recipients").upsert(rows, { onConflict: "campaign_id,email" }).select("id,email,data,is_valid");
  if (error) return res.status(500).json({ error: "Could not save recipients." }); res.status(201).json({ recipients: data, duplicatesIgnored: parsed.data.recipients.length - rows.length });
});

app.post("/api/campaigns/:campaignId/generate", requireUser, async (req, res) => {
  const userId = (req as AuthenticatedRequest).user.id; const campaignId = routeParam(req.params.campaignId); if (!await ownedCampaign(campaignId, userId)) return res.status(404).json({ error: "Campaign not found." });
  const { data: recipients, error: recipientError } = await supabase.from("recipients").select("id").eq("campaign_id", campaignId).eq("is_valid", true);
  if (recipientError) return res.status(500).json({ error: "Could not load recipients." });
  const rows = (recipients || []).map((recipient) => ({ campaign_id: campaignId, recipient_id: recipient.id, status: "pending" as const }));
  const { error } = rows.length ? await supabase.from("certificates").upsert(rows, { onConflict: "recipient_id" }) : { error: null };
  if (error) return res.status(500).json({ error: "Could not queue certificate generation." });
  await supabase.from("campaigns").update({ status: "generating" }).eq("id", req.params.campaignId);
  res.status(202).json({ queued: rows.length });
});

app.post("/api/campaigns/:campaignId/email-jobs", requireUser, async (req, res) => {
  const userId = (req as AuthenticatedRequest).user.id; const campaignId = routeParam(req.params.campaignId); if (!await ownedCampaign(campaignId, userId)) return res.status(404).json({ error: "Campaign not found." });
  const { data: certificates, error } = await supabase.from("certificates").select("id,recipient_id").eq("campaign_id", campaignId).eq("status", "generated");
  if (error) return res.status(500).json({ error: "Could not load generated certificates." });
  const rows = (certificates || []).map((certificate) => ({ recipient_id: certificate.recipient_id, certificate_id: certificate.id, idempotency_key: certificate.id }));
  const result = rows.length ? await supabase.from("email_jobs").upsert(rows, { onConflict: "idempotency_key", ignoreDuplicates: true }).select("id,status") : { data: [], error: null };
  if (result.error) return res.status(500).json({ error: "Could not queue email delivery." }); res.status(202).json({ jobs: result.data || [] });
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
