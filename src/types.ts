export type CampaignStatus = "Draft" | "Generating" | "Generated" | "Sending" | "Completed" | "Failed";

export type Campaign = {
  id: string;
  name: string;
  organization: string;
  description?: string;
  status: CampaignStatus;
  updatedAt: string;
  recipients: number;
};

export type CampaignDraft = Pick<Campaign, "name" | "organization" | "description">;
