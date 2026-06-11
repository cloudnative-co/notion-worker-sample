import { Worker } from "@notionhq/workers";
import { j } from "@notionhq/workers/schema-builder";

const worker = new Worker();
export default worker;

// ---------------------------------------------------------------------------
// 定数: 問い合わせ管理DBのプロパティ名（DB側の名前と一致させる）
// ---------------------------------------------------------------------------

const REQUIRED_FIELDS = ["影響範囲", "発生日時", "利用端末"] as const;
const STATUS_PROPERTY = "Status";
const DUE_DATE_PROPERTY = "対応期限";

// 緊急度ごとのSLA時間。期限計算をAIに任せず、ここで固定する
const SLA_HOURS: Record<string, number> = { 高: 4, 中: 24, 低: 72 };

// ヘルパー: Notionのプロパティ値が「未入力」かどうかを判定する
function isEmptyProperty(prop: any): boolean {
	if (!prop) return true;
	switch (prop.type) {
		case "title":
			return prop.title.length === 0;
		case "rich_text":
			return prop.rich_text.length === 0;
		case "select":
			return prop.select === null;
		case "multi_select":
			return prop.multi_select.length === 0;
		case "status":
			return prop.status === null;
		case "date":
			return prop.date === null;
		case "number":
			return prop.number === null;
		default:
			return false;
	}
}

// ---------------------------------------------------------------------------
// tool 1: checkRequiredFields（読み取り専用）
// 影響範囲、発生日時、利用端末が入力されているかを固定条件で確認する
// ---------------------------------------------------------------------------

worker.tool("checkRequiredFields", {
	title: "Check Required Fields",
	description:
		"問い合わせページに必須項目（影響範囲、発生日時、利用端末）が入力されているか確認する。問い合わせのトリアージの最初に使う。",
	schema: j.object({
		pageId: j.string().describe("問い合わせ管理DBの対象ページID。"),
	}),
	hints: { readOnlyHint: true },
	execute: async ({ pageId }, { notion }) => {
		const page = await notion.pages.retrieve({ page_id: pageId });
		const properties = (page as any).properties ?? {};
		const missingFields = REQUIRED_FIELDS.filter((name) =>
			isEmptyProperty(properties[name]),
		);
		return {
			ok: missingFields.length === 0,
			missingFields,
		};
	},
});

// ---------------------------------------------------------------------------
// tool 2: calculateSla（読み取り専用）
// 分類と緊急度から対応期限を機械的に計算する
// ---------------------------------------------------------------------------

worker.tool("calculateSla", {
	title: "Calculate SLA",
	description:
		"問い合わせの分類と緊急度から対応期限を計算する。問い合わせのトリアージ時に使う。",
	schema: j.object({
		category: j.string().describe("問い合わせの分類。"),
		urgency: j.enum("高", "中", "低").describe("問い合わせの緊急度。"),
	}),
	hints: { readOnlyHint: true },
	execute: async ({ category, urgency }) => {
		const hours = SLA_HOURS[urgency] ?? 72;
		const dueDate = new Date(Date.now() + hours * 60 * 60 * 1000);
		return { category, urgency, dueDate: dueDate.toISOString() };
	},
});

// ---------------------------------------------------------------------------
// tool 3: lookupDeviceAssignment（読み取り専用）
// 資産管理SaaSのAPIで端末の貸与状況を確認する。認証情報はsecretsで保持し、
// AIには渡さない。接続先未設定のときはデモ用のモック応答を返す
// ---------------------------------------------------------------------------

worker.tool("lookupDeviceAssignment", {
	title: "Lookup Device Assignment",
	description:
		"資産管理SaaSのAPIで、申告された利用端末（資産管理番号）の貸与状況を確認する。問い合わせのトリアージ時に使う。",
	schema: j.object({
		assetTag: j.string().describe("利用端末の資産管理番号。例: CN-PC-0123"),
	}),
	hints: { readOnlyHint: true },
	execute: async ({
		assetTag,
	}): Promise<
		| {
				mock: true;
				assetTag: string;
				found: true;
				assignedTo: string;
				status: string;
				note: string;
		  }
		| { mock: false; assetTag: string; found: false }
		| {
				mock: false;
				assetTag: string;
				found: true;
				assignedTo: string | null;
				status: string | null;
		  }
	> => {
		const baseUrl = process.env.ASSET_API_BASE_URL;
		const apiToken = process.env.ASSET_API_TOKEN;

		// デモ・記事撮影用: 接続先が未設定ならモック応答を返す
		if (!baseUrl || !apiToken) {
			return {
				mock: true,
				assetTag,
				found: true,
				assignedTo: "デモ 太郎",
				status: "貸与中",
				note: "ASSET_API_BASE_URL / ASSET_API_TOKEN 未設定のためモック応答です。",
			};
		}

		// tool内の外部API呼び出しは、短時間で返る確認に絞る（タイムアウト5秒）
		const response = await fetch(
			`${baseUrl}/api/v1/devices/${encodeURIComponent(assetTag)}`,
			{
				headers: { Authorization: `Bearer ${apiToken}` },
				signal: AbortSignal.timeout(5000),
			},
		);

		if (response.status === 404) {
			return { mock: false, assetTag, found: false };
		}
		if (!response.ok) {
			throw new Error(`資産管理APIエラー: ${response.status}`);
		}

		const device = (await response.json()) as Record<string, unknown>;
		return {
			mock: false,
			assetTag,
			found: true,
			assignedTo: typeof device.assigned_to === "string" ? device.assigned_to : null,
			status: typeof device.status === "string" ? device.status : null,
		};
	},
});

// ---------------------------------------------------------------------------
// tool 4: updateTicketStatus（書き込みtool。readOnlyHintを付けない）
// 遷移はNew→Reviewingだけに固定し、対応期限を書き込む。
// hintが無いため、デフォルトではCustom Agentが実行前にユーザーの許可を求める
// ---------------------------------------------------------------------------

worker.tool("updateTicketStatus", {
	title: "Update Ticket Status",
	description:
		"問い合わせページのStatusをNewからReviewingへ進め、対応期限を書き込む。トリアージ完了時に1回だけ使う。Reviewing以降の遷移には使わない。",
	schema: j.object({
		pageId: j.string().describe("問い合わせ管理DBの対象ページID。"),
		dueDate: j
			.string()
			.describe("calculateSlaが返した対応期限。ISO 8601形式。"),
	}),
	execute: async (
		{ pageId, dueDate },
		{ notion },
	): Promise<
		| { updated: false; currentStatus: string | null; reason: string }
		| {
				updated: true;
				previousStatus: string;
				newStatus: string;
				dueDate: string;
		  }
	> => {
		const page = await notion.pages.retrieve({ page_id: pageId });
		const statusProp = (page as any).properties?.[STATUS_PROPERTY];

		// Statusがセレクト型でもステータス型でも動くようにする
		const currentStatus =
			statusProp?.type === "status"
				? statusProp.status?.name
				: statusProp?.type === "select"
					? statusProp.select?.name
					: null;

		// 書き込み条件を固定する: New以外からは遷移させない
		if (currentStatus !== "New") {
			return {
				updated: false,
				currentStatus,
				reason: "StatusがNewではないため更新しません。",
			};
		}

		await notion.pages.update({
			page_id: pageId,
			properties: {
				[STATUS_PROPERTY]:
					statusProp.type === "status"
						? { status: { name: "Reviewing" } }
						: { select: { name: "Reviewing" } },
				[DUE_DATE_PROPERTY]: { date: { start: dueDate } },
			},
		});

		return {
			updated: true,
			previousStatus: "New",
			newStatus: "Reviewing",
			dueDate,
		};
	},
});

// ---------------------------------------------------------------------------
// Webhookハンドラ: normalizeEvent
// 外部サービス（資産管理SaaSなど）のイベントを正規化し、イベント記録DBへ入れる。
// Webhookのcontext.notionは自動認証されないため、NOTION_API_TOKENをsecretsに
// 設定しておく必要がある
// ---------------------------------------------------------------------------

worker.webhook("normalizeEvent", {
	title: "Normalize External Event",
	description:
		"外部サービスのイベントを受け、日時やIDの形式を正規化してNotionのイベント記録DBへ書き込む。",
	execute: async (events, { notion }) => {
		const databaseId = process.env.EVENT_LOG_DATABASE_ID;
		if (!databaseId) {
			throw new Error("EVENT_LOG_DATABASE_ID is not configured");
		}

		// Notion API 2025-09-03以降、クエリはデータベース直下のデータソースに
		// 対して行うため、データベースIDからデータソースIDを解決する
		const database = await notion.databases.retrieve({
			database_id: databaseId,
		});
		const dataSourceId = (database as any).data_sources?.[0]?.id;
		if (!dataSourceId) {
			throw new Error("イベント記録DBのデータソースを取得できませんでした");
		}

		for (const event of events) {
			// 本番運用では、ここでプロバイダーの署名検証を行い、失敗時は
			// WebhookVerificationError を投げる（公式Webhooksガイド参照）

			const body = event.body as Record<string, unknown>;

			// 正規化: 外部サービスごとのフィールド名の揺れを吸収する
			const externalId =
				typeof body.event_id === "string"
					? body.event_id
					: typeof body.id === "string"
						? body.id
						: event.deliveryId;
			const eventType = typeof body.type === "string" ? body.type : "unknown";
			const occurredAtRaw = body.occurred_at ?? body.timestamp ?? body.created_at;
			const occurredAt =
				typeof occurredAtRaw === "string" &&
				!Number.isNaN(Date.parse(occurredAtRaw))
					? new Date(occurredAtRaw).toISOString()
					: new Date().toISOString();

			// 冪等性: 外部イベントIDで既存レコードを確認し、二重記録を防ぐ。
			// deliveryIdはNotion側リトライでは安定するが、プロバイダーの再送では
			// 変わるため、外部ID優先で判定する
			const existing = await notion.dataSources.query({
				data_source_id: dataSourceId,
				filter: {
					property: "外部イベントID",
					rich_text: { equals: externalId },
				},
			});
			if (existing.results.length > 0) continue;

			await notion.pages.create({
				parent: { database_id: databaseId },
				properties: {
					イベント名: {
						title: [{ text: { content: `${eventType} (${externalId})` } }],
					},
					外部イベントID: {
						rich_text: [{ text: { content: externalId } }],
					},
					種別: { select: { name: eventType } },
					発生日時: { date: { start: occurredAt } },
					Raw: {
						rich_text: [
							{ text: { content: JSON.stringify(body).slice(0, 1900) } },
						],
					},
				},
			});
		}
	},
});
