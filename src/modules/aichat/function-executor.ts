// Function execution handler for aichat module

import 藍 from '@/ai.js';
import { bindThis } from '@/decorators.js';
import { AVAILABLE_FUNCTIONS } from './functions.js';

export type FunctionCall = {
	name: string;
	arguments: Record<string, any>;
};

export default class FunctionExecutor {
	private ai: 藍;

	constructor(ai: 藍) {
		this.ai = ai;
	}

	@bindThis
	public async execute(functionCall: FunctionCall): Promise<string> {
		this.log(`Executing function: ${functionCall.name}`);

		try {
			switch (functionCall.name) {
				case 'users_notes':
					return await this.executeUsersNotes(functionCall.arguments);
				default:
					return JSON.stringify({ error: `Unknown function: ${functionCall.name}` });
			}
		} catch (err: unknown) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			this.log(`Function execution error: ${errorMsg}`);
			return JSON.stringify({ error: errorMsg });
		}
	}

	@bindThis
	private async executeUsersNotes(args: Record<string, any>): Promise<string> {
		this.log(`Fetching notes for userId: ${args.userId}`);

		const params: Record<string, any> = {
			userId: args.userId,
			limit: args.limit ?? 10,
		};

		// オプショナルパラメータを追加
		if (args.sinceDate !== undefined) {
			params.sinceDate = args.sinceDate;
		}
		if (args.sinceId !== undefined) {
			params.sinceId = args.sinceId;
		}
		if (args.untilDate !== undefined) {
			params.untilDate = args.untilDate;
		}
		if (args.untilId !== undefined) {
			params.untilId = args.untilId;
		}
		if (args.withChannelNotes !== undefined) {
			params.withChannelNotes = args.withChannelNotes;
		}
		if (args.withFiles !== undefined) {
			params.withFiles = args.withFiles;
		}
		if (args.withRenotes !== undefined) {
			params.withRenotes = args.withRenotes;
		}
		if (args.withReplies !== undefined) {
			params.withReplies = args.withReplies;
		}

		try {
			const result = await this.ai.api('users/notes', params);
			// レスポンスフィルタリング
			const filtered = this.filterResponse('users_notes', result);
			return JSON.stringify(filtered);
		} catch (err: unknown) {
			const errorMsg = err instanceof Error ? err.message : String(err);
			this.log(`API error: ${errorMsg}`);
			throw new Error(`Failed to fetch user notes: ${errorMsg}`);
		}
	}

	@bindThis
	private filterResponse(functionName: string, response: any): any {
		// 関数スキーマから responseFields を取得
		const functionSchema = AVAILABLE_FUNCTIONS.find(f => f.name === functionName);
		if (!functionSchema || !functionSchema.responseFields) {
			return response;
		}

		const responseFields = functionSchema.responseFields;

		// レスポンスが配列の場合、各要素からフィールドを抽出
		if (Array.isArray(response)) {
			return response.map(item => {
				const filtered: Record<string, any> = {};
				for (const field of responseFields) {
					if (field in item) {
						filtered[field] = item[field];
					}
				}
				return filtered;
			});
		}

		// レスポンスがオブジェクトの場合、フィールドを抽出
		if (typeof response === 'object' && response !== null) {
			const filtered: Record<string, any> = {};
			for (const field of responseFields) {
				if (field in response) {
					filtered[field] = response[field];
				}
			}
			return filtered;
		}

		return response;
	}

	@bindThis
	private log(msg: string) {
		this.ai.log(`[FunctionExecutor]: ${msg}`);
	}
}
