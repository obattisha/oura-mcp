/**
 * Browser-facing OAuth routes. The MCP client (Claude) authenticates against
 * this Worker; the Worker in turn sends you through Oura's OAuth to get an
 * Oura token. Adapted from Cloudflare's remote-mcp-github-oauth template.
 */
import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import { exchangeCode, fetchPersonalInfo, OURA_AUTHORIZE_URL, OURA_SCOPES, saveTokens } from "./oura";
import {
	addApprovedClient,
	bindStateToSession,
	createOAuthState,
	generateCSRFProtection,
	isClientApproved,
	OAuthError,
	renderApprovalDialog,
	validateCSRFToken,
	validateOAuthState,
} from "./workers-oauth-utils";

export type Props = {
	ouraUserId: string;
	email: string;
};

const app = new Hono<{ Bindings: Env & { OAUTH_PROVIDER: OAuthHelpers } }>();

app.get("/", (c) => c.text("Oura MCP server. Connect an MCP client to /mcp."));

app.get("/authorize", async (c) => {
	const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
	const { clientId } = oauthReqInfo;
	if (!clientId) {
		return c.text("Invalid request", 400);
	}

	if (await isClientApproved(c.req.raw, clientId, c.env.COOKIE_ENCRYPTION_KEY)) {
		const { stateToken } = await createOAuthState(oauthReqInfo, c.env.OAUTH_KV);
		const { setCookie } = await bindStateToSession(stateToken);
		return redirectToOura(c.req.raw, c.env, stateToken, { "Set-Cookie": setCookie });
	}

	const { token: csrfToken, setCookie } = generateCSRFProtection();
	return renderApprovalDialog(c.req.raw, {
		client: await c.env.OAUTH_PROVIDER.lookupClient(clientId),
		csrfToken,
		server: {
			name: "Oura MCP",
			description: "Read-only access to your Oura Ring data.",
		},
		setCookie,
		state: { oauthReqInfo },
	});
});

app.post("/authorize", async (c) => {
	try {
		const formData = await c.req.raw.formData();
		validateCSRFToken(formData, c.req.raw);

		const encodedState = formData.get("state");
		if (!encodedState || typeof encodedState !== "string") {
			return c.text("Missing state in form data", 400);
		}

		let state: { oauthReqInfo?: AuthRequest };
		try {
			state = JSON.parse(atob(encodedState));
		} catch (_e) {
			return c.text("Invalid state data", 400);
		}
		if (!state.oauthReqInfo || !state.oauthReqInfo.clientId) {
			return c.text("Invalid request", 400);
		}

		const approvedClientCookie = await addApprovedClient(
			c.req.raw,
			state.oauthReqInfo.clientId,
			c.env.COOKIE_ENCRYPTION_KEY,
		);
		const { stateToken } = await createOAuthState(state.oauthReqInfo, c.env.OAUTH_KV);
		const { setCookie: sessionBindingCookie } = await bindStateToSession(stateToken);

		const headers = new Headers();
		headers.append("Set-Cookie", approvedClientCookie);
		headers.append("Set-Cookie", sessionBindingCookie);
		return redirectToOura(c.req.raw, c.env, stateToken, Object.fromEntries(headers));
	} catch (error: any) {
		console.error("POST /authorize error:", error);
		if (error instanceof OAuthError) {
			return error.toResponse();
		}
		return c.text(`Internal server error: ${error.message}`, 500);
	}
});

function redirectToOura(request: Request, env: Env, stateToken: string, headers: Record<string, string> = {}) {
	const url = new URL(OURA_AUTHORIZE_URL);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", env.OURA_CLIENT_ID);
	url.searchParams.set("redirect_uri", new URL("/callback", request.url).href);
	url.searchParams.set("scope", OURA_SCOPES.join(" "));
	url.searchParams.set("state", stateToken);
	return new Response(null, { status: 302, headers: { ...headers, location: url.href } });
}

app.get("/callback", async (c) => {
	let oauthReqInfo: AuthRequest;
	let clearSessionCookie: string;
	try {
		const result = await validateOAuthState(c.req.raw, c.env.OAUTH_KV);
		oauthReqInfo = result.oauthReqInfo;
		clearSessionCookie = result.clearCookie;
	} catch (error: any) {
		if (error instanceof OAuthError) {
			return error.toResponse();
		}
		return c.text("Internal server error", 500);
	}
	if (!oauthReqInfo.clientId) {
		return c.text("Invalid OAuth request data", 400);
	}

	const code = c.req.query("code");
	if (!code) {
		return c.text(`Oura did not return a code: ${c.req.query("error") ?? "unknown error"}`, 400);
	}

	let tokens;
	let user;
	try {
		tokens = await exchangeCode(c.env, code, new URL("/callback", c.req.url).href);
		user = await fetchPersonalInfo(tokens.access_token);
	} catch (error: any) {
		console.error("Oura sign-in failed:", error);
		return c.text("Failed to sign in with Oura", 502);
	}

	// Anyone with an Oura account could otherwise connect and spend this app's API quota.
	if (user.email?.toLowerCase() !== c.env.ALLOWED_OURA_EMAIL.toLowerCase()) {
		return c.text("This Oura account is not allowed to use this server.", 403);
	}

	await saveTokens(c.env, user.id, tokens);

	const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
		metadata: { label: user.email },
		props: { ouraUserId: user.id, email: user.email } satisfies Props,
		request: oauthReqInfo,
		scope: oauthReqInfo.scope,
		userId: user.id,
	});

	const headers = new Headers({ Location: redirectTo });
	if (clearSessionCookie) {
		headers.set("Set-Cookie", clearSessionCookie);
	}
	return new Response(null, { status: 302, headers });
});

export { app as OuraHandler };
