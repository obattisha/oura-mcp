/**
 * Minimal Oura API v2 client plus token storage.
 *
 * Oura access tokens expire and refresh tokens are single-use, so tokens are
 * kept in KV (keyed by Oura user id) rather than baked into the MCP grant.
 * Every MCP session for the same Oura account then shares one token pair, and
 * a refresh in one session doesn't strand the others with a spent refresh token.
 */

export const OURA_AUTHORIZE_URL = "https://cloud.ouraring.com/oauth/authorize";
export const OURA_TOKEN_URL = "https://api.ouraring.com/oauth/token";
const OURA_API_BASE = "https://api.ouraring.com/v2/usercollection/";

export const OURA_SCOPES = [
	"email",
	"personal",
	"daily",
	"heartrate",
	"workout",
	"tag",
	"session",
	"spo2Daily",
];

// Collections queried with start_date / end_date (YYYY-MM-DD).
export const DATE_COLLECTIONS = [
	"daily_activity",
	"daily_cardiovascular_age",
	"daily_readiness",
	"daily_resilience",
	"daily_sleep",
	"daily_spo2",
	"daily_stress",
	"enhanced_tag",
	"rest_mode_period",
	"session",
	"sleep",
	"sleep_time",
	"vO2_max",
	"workout",
] as const;
export type DateCollection = (typeof DATE_COLLECTIONS)[number];

export type StoredTokens = {
	access_token: string;
	refresh_token: string;
	/** Epoch milliseconds. */
	expires_at: number;
};

type TokenResponse = {
	access_token: string;
	refresh_token: string;
	expires_in: number;
};

const tokenKey = (userId: string) => `oura_tokens:${userId}`;

function toStored(t: TokenResponse): StoredTokens {
	return {
		access_token: t.access_token,
		refresh_token: t.refresh_token,
		expires_at: Date.now() + t.expires_in * 1000,
	};
}

async function postToken(params: Record<string, string>): Promise<StoredTokens> {
	const resp = await fetch(OURA_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(params).toString(),
	});
	if (!resp.ok) {
		throw new Error(`Oura token request failed (${resp.status}): ${await resp.text()}`);
	}
	return toStored((await resp.json()) as TokenResponse);
}

export function exchangeCode(env: Env, code: string, redirectUri: string) {
	return postToken({
		grant_type: "authorization_code",
		code,
		redirect_uri: redirectUri,
		client_id: env.OURA_CLIENT_ID,
		client_secret: env.OURA_CLIENT_SECRET,
	});
}

export async function saveTokens(env: Env, userId: string, tokens: StoredTokens) {
	await env.OAUTH_KV.put(tokenKey(userId), JSON.stringify(tokens));
}

async function refreshTokens(env: Env, userId: string, current: StoredTokens) {
	const fresh = await postToken({
		grant_type: "refresh_token",
		refresh_token: current.refresh_token,
		client_id: env.OURA_CLIENT_ID,
		client_secret: env.OURA_CLIENT_SECRET,
	});
	await saveTokens(env, userId, fresh);
	return fresh;
}

export class OuraClient {
	constructor(
		private env: Env,
		private userId: string,
	) {}

	private async tokens(): Promise<StoredTokens> {
		const raw = await this.env.OAUTH_KV.get(tokenKey(this.userId));
		if (!raw) {
			throw new Error("No Oura tokens stored. Disconnect and reconnect this MCP server to sign in again.");
		}
		const tokens = JSON.parse(raw) as StoredTokens;
		// Refresh a minute early so a request doesn't race the expiry.
		if (tokens.expires_at - Date.now() < 60_000) {
			return refreshTokens(this.env, this.userId, tokens);
		}
		return tokens;
	}

	private async request(path: string, params?: Record<string, string>): Promise<unknown> {
		const url = OURA_API_BASE + path + (params ? `?${new URLSearchParams(params)}` : "");
		let tokens = await this.tokens();
		let resp = await fetch(url, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
		if (resp.status === 401) {
			// Token was revoked or expired early; refresh once and retry.
			tokens = await refreshTokens(this.env, this.userId, tokens);
			resp = await fetch(url, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
		}
		if (!resp.ok) {
			throw new Error(`Oura API ${path} failed (${resp.status}): ${await resp.text()}`);
		}
		return resp.json();
	}

	/** Fetch every page of a paginated collection. */
	async list(path: string, params: Record<string, string>): Promise<Record<string, unknown>[]> {
		const all: Record<string, unknown>[] = [];
		let nextToken: string | null = null;
		do {
			const page = (await this.request(path, nextToken ? { ...params, next_token: nextToken } : params)) as {
				data: Record<string, unknown>[];
				next_token: string | null;
			};
			all.push(...page.data);
			nextToken = page.next_token;
		} while (nextToken);
		return all;
	}

	get(path: string) {
		return this.request(path);
	}

	personalInfo() {
		return this.request("personal_info") as Promise<{ id: string; email?: string; [k: string]: unknown }>;
	}
}

/** Personal info fetch used during sign-in, before tokens are in KV. */
export async function fetchPersonalInfo(accessToken: string) {
	const resp = await fetch(`${OURA_API_BASE}personal_info`, {
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	if (!resp.ok) {
		throw new Error(`Oura personal_info failed (${resp.status}): ${await resp.text()}`);
	}
	return (await resp.json()) as { id: string; email?: string };
}
