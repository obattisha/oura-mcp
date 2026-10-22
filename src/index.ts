import { env } from "cloudflare:workers";
import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler, getMcpAuthContext } from "agents/mcp/server";
import { z } from "zod";
import { DATE_COLLECTIONS, OuraClient } from "./oura";
import { OuraHandler, type Props } from "./oura-handler";

// High-resolution series inside sleep/activity documents. They dominate the
// payload size and are rarely needed, so tools drop them unless asked.
const TIMESERIES_FIELDS = new Set([
	"heart_rate",
	"hrv",
	"movement_30_sec",
	"sleep_phase_5_min",
	"sleep_phase_30_sec",
	"met",
	"class_5_min",
	"motion_count",
]);

function stripTimeseries(doc: Record<string, unknown>) {
	return Object.fromEntries(Object.entries(doc).filter(([k]) => !TIMESERIES_FIELDS.has(k)));
}

const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => isoDate(new Date(Date.now() - n * 86_400_000));

const dateRange = {
	start_date: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/)
		.optional()
		.describe("YYYY-MM-DD. Defaults to 7 days ago."),
	end_date: z
		.string()
		.regex(/^\d{4}-\d{2}-\d{2}$/)
		.optional()
		.describe("YYYY-MM-DD. Defaults to today."),
};

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }] });

function createServer() {
	const server = new McpServer({ name: "Oura", version: "0.1.0" });
	const props = getMcpAuthContext()?.props as Props | undefined;
	if (!props) {
		return server;
	}
	const oura = new OuraClient(env, props.ouraUserId);

	server.registerTool(
		"get_daily_summary",
		{
			description:
				"One row per day combining Oura's daily sleep, readiness, activity, stress, and SpO2 scores and their contributors. Start here for questions like 'how did I sleep this week' or 'how's my recovery trending'.",
			inputSchema: z.object(dateRange),
		},
		async ({ start_date = daysAgo(7), end_date = isoDate(new Date()) }) => {
			const params = { start_date, end_date };
			const sources = ["daily_sleep", "daily_readiness", "daily_activity", "daily_stress", "daily_spo2"] as const;
			const results = await Promise.all(sources.map((s) => oura.list(s, params)));

			const byDay = new Map<string, Record<string, unknown>>();
			sources.forEach((source, i) => {
				for (const doc of results[i]) {
					const day = doc.day as string;
					const { id: _id, day: _day, timestamp: _ts, ...rest } = stripTimeseries(doc);
					const row = byDay.get(day) ?? { day };
					row[source.replace("daily_", "")] = rest;
					byDay.set(day, row);
				}
			});
			return json([...byDay.values()].sort((a, b) => String(a.day).localeCompare(String(b.day))));
		},
	);

	server.registerTool(
		"get_collection",
		{
			description:
				"Raw Oura documents for one collection over a date range. Use 'sleep' for individual sleep periods (bedtime, stages, HRV, lowest heart rate), 'workout' and 'session' for activities, 'enhanced_tag' for tags.",
			inputSchema: z.object({
				collection: z.enum(DATE_COLLECTIONS),
				...dateRange,
				include_timeseries: z
					.boolean()
					.default(false)
					.describe("Include 5-minute/30-second series (heart_rate, hrv, sleep phases, MET). Large."),
			}),
		},
		async ({ collection, start_date = daysAgo(7), end_date = isoDate(new Date()), include_timeseries }) => {
			const docs = await oura.list(collection, { start_date, end_date });
			return json(include_timeseries ? docs : docs.map(stripTimeseries));
		},
	);

	server.registerTool(
		"get_heart_rate",
		{
			description:
				"Heart rate samples between two datetimes, aggregated per hour (min/avg/max, by source such as 'awake', 'rest', 'sleep', 'workout'). Ranges longer than 7 days are rejected.",
			inputSchema: z.object({
				start_datetime: z.string().describe("ISO 8601, e.g. 2026-10-21T00:00:00-05:00"),
				end_datetime: z.string().describe("ISO 8601"),
			}),
		},
		async ({ start_datetime, end_datetime }) => {
			const span = Date.parse(end_datetime) - Date.parse(start_datetime);
			if (!(span > 0) || span > 7 * 86_400_000) {
				throw new Error("end_datetime must be after start_datetime and within 7 days of it.");
			}
			const rows = (await oura.list("heartrate", { start_datetime, end_datetime })) as {
				bpm: number;
				source: string;
				timestamp: string;
			}[];

			const buckets = new Map<string, { hour: string; source: string; n: number; sum: number; min: number; max: number }>();
			for (const { bpm, source, timestamp } of rows) {
				const hour = timestamp.slice(0, 13) + ":00";
				const key = `${hour}|${source}`;
				const b = buckets.get(key) ?? { hour, source, n: 0, sum: 0, min: Infinity, max: -Infinity };
				b.n++;
				b.sum += bpm;
				b.min = Math.min(b.min, bpm);
				b.max = Math.max(b.max, bpm);
				buckets.set(key, b);
			}
			return json(
				[...buckets.values()].map(({ hour, source, n, sum, min, max }) => ({
					hour,
					source,
					samples: n,
					avg: Math.round(sum / n),
					min,
					max,
				})),
			);
		},
	);

	server.registerTool(
		"get_personal_info",
		{ description: "Age, weight, height, and biological sex from the Oura profile." },
		async () => json(await oura.personalInfo()),
	);

	server.registerTool(
		"get_ring_configuration",
		{ description: "The user's Oura ring hardware: model, color, size, firmware." },
		async () => json(await oura.list("ring_configuration", {})),
	);

	return server;
}

const mcpHandler = createMcpHandler(createServer);

export default new OAuthProvider({
	allowPlainPKCE: false,
	apiHandler: {
		fetch(request: Request, bindings: Env, ctx: ExecutionContext) {
			return mcpHandler(request, bindings, ctx);
		},
	} satisfies ExportedHandler<Env>,
	apiRoute: "/mcp",
	authorizeEndpoint: "/authorize",
	clientRegistrationEndpoint: "/register",
	defaultHandler: OuraHandler as any,
	tokenEndpoint: "/token",
});
