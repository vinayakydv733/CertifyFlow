import type { Campaign, CampaignDraft } from "./types";
import { supabase } from "./supabase";

type ApiCampaign = {
  id: string;
  name: string;
  organization_name: string;
  description: string | null;
  status: Campaign["status"] | Lowercase<Campaign["status"]>;
  updated_at: string;
  recipients?: number;
};

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const { data } = await supabase!.auth.getSession();
  const response = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...(data.session ? { Authorization: `Bearer ${data.session.access_token}` } : {}), ...options.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "The server could not complete that request.");
  return body as T;
}

function mapCampaign(campaign: ApiCampaign): Campaign {
  const status = campaign.status.toString().toLowerCase();
  return { id: campaign.id, name: campaign.name, organization: campaign.organization_name, description: campaign.description || undefined, status: (status.charAt(0).toUpperCase() + status.slice(1)) as Campaign["status"], updatedAt: new Date(campaign.updated_at).toLocaleDateString(), recipients: campaign.recipients || 0 };
}

export async function listCampaigns() {
  const result = await request<{ campaigns: ApiCampaign[] }>("/api/campaigns");
  return result.campaigns.map(mapCampaign);
}

export async function createCampaign(draft: CampaignDraft) {
  const result = await request<{ campaign: ApiCampaign }>("/api/campaigns", { method: "POST", body: JSON.stringify({ name: draft.name, organizationName: draft.organization, description: draft.description || undefined }) });
  return mapCampaign(result.campaign);
}

export async function uploadTemplate(campaignId: string, file: File) {
  const { data } = await supabase!.auth.getSession();
  const response = await fetch(`/api/campaigns/${campaignId}/template`, { method: "POST", body: file, headers: { "Content-Type": file.type, Authorization: `Bearer ${data.session?.access_token || ""}` } });
  const body = await response.json().catch(() => ({})); if (!response.ok) throw new Error(body.error || "Could not upload the template."); return body;
}

export async function saveRecipients(campaignId: string, recipients: { name: string; email: string; college?: string; achievement?: string }[]) {
  return request<{ recipients: unknown[]; duplicatesIgnored: number }>(`/api/campaigns/${campaignId}/recipients`, { method: "POST", body: JSON.stringify({ recipients }) });
}

export async function queueGeneration(campaignId: string) {
  return request<{ queued: number }>(`/api/campaigns/${campaignId}/generate`, { method: "POST" });
}

export async function queueEmailJobs(campaignId: string) {
  return request<{ jobs: unknown[] }>(`/api/campaigns/${campaignId}/email-jobs`, { method: "POST" });
}

export async function startGmailConnection() {
  return request<{ url: string }>("/api/gmail/connect", { method: "POST" });
}

export async function getGmailConnection() {
  return request<{ connected: boolean; connection: { gmail_address: string } | null }>("/api/gmail/connection");
}

export async function disconnectGmail() {
  return request<void>("/api/gmail/connection", { method: "DELETE" });
}
