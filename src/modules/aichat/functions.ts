// Function calling definitions for aichat module

export type FunctionParameter = {
	type: string;
	format?: string;
	description: string;
	required?: boolean;
	minimum?: number;
	maximum?: number;
	default?: any;
	items?: any;
};

export type FunctionSchema = {
	name: string;
	description: string;
	parameters: {
		type: string;
		properties: Record<string, FunctionParameter>;
		required: string[];
	};
	responseFields?: string[];
};

export const AVAILABLE_FUNCTIONS: FunctionSchema[] = [
	{
		name: 'users_notes',
		description: 'ユーザーの投稿一覧を取得します',
		parameters: {
			type: 'object',
			properties: {
				userId: {
					type: 'string',
					format: 'misskey:id',
					description: 'ユーザーID'
				},
				limit: {
					type: 'integer',
					description: '取得する投稿数',
					minimum: 1,
					maximum: 100,
					default: 10
				},
				sinceDate: {
					type: 'integer',
					description: '指定した日時以降の投稿を取得'
				},
				sinceId: {
					type: 'string',
					format: 'misskey:id',
					description: '指定した投稿以降の投稿を取得'
				},
				untilDate: {
					type: 'integer',
					description: '指定した日時以前の投稿を取得'
				},
				untilId: {
					type: 'string',
					format: 'misskey:id',
					description: '指定した投稿以前の投稿を取得'
				},
				withChannelNotes: {
					type: 'boolean',
					description: 'チャンネルの投稿を含める',
					default: false
				},
				withFiles: {
					type: 'boolean',
					description: 'ファイルを含む投稿のみ取得',
					default: false
				},
				withRenotes: {
					type: 'boolean',
					description: 'リノートを含める',
					default: true
				},
				withReplies: {
					type: 'boolean',
					description: 'リプライを含める',
					default: false
				}
			},
			required: ['userId']
		},
		responseFields: ['text']
	}
];

// Function schema for Gemini API
export function getGeminiFunctionSchema() {
	return AVAILABLE_FUNCTIONS.map(func => ({
		name: func.name,
		description: func.description,
		parameters: {
			type: func.parameters.type,
			properties: func.parameters.properties,
			required: func.parameters.required
		}
	}));
}
