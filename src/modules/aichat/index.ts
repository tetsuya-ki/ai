import { bindThis } from '@/decorators.js';
import Module from '@/module.js';
import serifs from '@/serifs.js';
import Message from '@/message.js';
import config from '@/config.js';
import Friend from '@/friend.js';
import urlToBase64 from '@/utils/url2base64.js';
import urlToJson from '@/utils/url2json.js';
import got, { HTTPError } from 'got';
import loki from 'lokijs';

type AiChat = {
	question: string;
	prompt: string;
	api: string;
	key: string;
	fromMention: boolean;
	friendName?: string;
	grounding?: boolean;
	history?: { role: string; content: string }[];
};
type base64File = {
	type: string;
	base64: string;
	url?: string;
};
type GeminiParts = {
	inlineData?: {
		mimeType: string;
		data: string;
	};
	fileData?: {
		mimeType?: string;
		fileUri: string;
	};
	text?: string;
}[];
type GeminiSystemInstruction = {
	role: string;
	parts: [{text: string}]
};
type GeminiContents = {
	role: string;
	parts: GeminiParts;
};
type GeminiOptions = {
	contents?: GeminiContents[],
	systemInstruction?: GeminiSystemInstruction,
	tools?: [{}]
};

type CallGeminiOptions  = {
	url: string,
	searchParams: {
		key: string,
	},
	json: GeminiOptions,
};

type AiChatHist = {
	postId: string;
	createdAt: number;
	type: string;
	fromMention: boolean;
	api?: string;
	grounding?: boolean;
	history?: {
		role: string;
		content: string;
	}[];
};

type UrlPreview = {
	title: string;
	icon: string;
	description: string;
	thumbnail: string;
	player: {
		url: string
		width: number;
		height: number;
		allow: []
	}
	sitename: string;
	sensitive: boolean;
	activityPub: string;
	url: string;
};

const KIGO = '&';
const TYPE_GEMINI = 'gemini';
const GEMINI_PRO = 'gemini-pro';
const GEMINI_FLASH = 'gemini-flash';
const TYPE_PLAMO = 'plamo';
const GROUNDING_TARGET = 'ggg';
const YOUTUBE_SITE_URL = 'https://www.youtube.com/';
const YOUTUBE_SHORT_URL = 'https://youtu.be/';

const GEMINI_25_FLASH_API = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const GEMINI_20_FLASH_API = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';
const GEMINI_25_PRO_API = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent';
// const GEMINI_20_PRO_API = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-pro:generateContent';
const PLAMO_API = 'https://api.platform.preferredai.jp/v1/chat/completions';

const RANDOMTALK_DEFAULT_PROBABILITY = 0.02;// デフォルトのrandomTalk確率
const TIMEOUT_TIME = 1000 * 60 * 60 * 0.5;// aichatの返信を監視する時間
const RANDOMTALK_DEFAULT_INTERVAL = 1000 * 60 * 60 * 12;// デフォルトのrandomTalk間隔
const MEMORY_MAX: number = 5; //個人ごとの記憶の最大件数

export default class extends Module {
	public readonly name = 'aichat';
	private aichatHist: loki.Collection<AiChatHist>|undefined;
	private aichatMemory: loki.Collection<{ userId: string; memory: string[] }> | undefined; // ユーザーごとの記憶
	private randomTalkProbability: number = RANDOMTALK_DEFAULT_PROBABILITY;
	private randomTalkIntervalMinutes: number = RANDOMTALK_DEFAULT_INTERVAL;

	@bindThis
	public install() {
		this.aichatHist = this.ai.getCollection('aichatHist', {
			indices: ['postId']
		});
		// 記憶コレクションを追加
		this.aichatMemory = this.ai.getCollection('aichatMemory', {
			indices: ['userId']
		});

		// 確率は設定されていればそちらを採用(設定がなければデフォルトを採用)
		if (config.aichatRandomTalkProbability != undefined && !Number.isNaN(Number.parseFloat(config.aichatRandomTalkProbability))) {
			this.randomTalkProbability = Number.parseFloat(config.aichatRandomTalkProbability);
		}
		// ランダムトーク間隔(分)は設定されていればそちらを採用(設定がなければデフォルトを採用)
		if (config.aichatRandomTalkIntervalMinutes != undefined && !Number.isNaN(Number.parseInt(config.aichatRandomTalkIntervalMinutes))) {
			this.randomTalkIntervalMinutes = 1000 * 60 * Number.parseInt(config.aichatRandomTalkIntervalMinutes);
		}
		this.log('aichatRandomTalkEnabled:' + config.aichatRandomTalkEnabled);
		this.log('randomTalkProbability:' + this.randomTalkProbability);
		this.log('randomTalkIntervalMinutes:' + (this.randomTalkIntervalMinutes / (60 * 1000)));
		this.log('aichatGroundingWithGoogleSearchAlwaysEnabled:' + config.aichatGroundingWithGoogleSearchAlwaysEnabled);

		// 定期的にデータを取得しaichatRandomTalkを行う
		if (config.aichatRandomTalkEnabled) {
			setInterval(this.aichatRandomTalk, this.randomTalkIntervalMinutes);
		}

		return {
			mentionHook: this.mentionHook,
			contextHook: this.contextHook,
			timeoutCallback: this.timeoutCallback,
		};
	}

	@bindThis
	private async genTextByGemini(aiChat: AiChat, files:base64File[], isMemory: boolean = false): Promise<string> {
		this.log('Generate Text By Gemini...');
		let parts: GeminiParts = [];
		const now = new Date().toLocaleString('ja-JP', {
			timeZone: 'Asia/Tokyo',
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit'
		});
		// 設定のプロンプトに加え、Misskeyの注意事項やMFM記法について説明
		let systemInstructionText = '';
		let youtubeUrl:string = '';
		if (!isMemory) {
			systemInstructionText = aiChat.prompt + 'ただし、リスト記法はMisskeyが対応しておらず、パーサーが壊れるため使用禁止です。列挙する場合は「・」を使ってください。さらにMisskeyではMFM記法を使うため、次のルールを守ってください。引用は行頭に>、フォント変更は$[font.serif テキスト](明朝体風)、$[font.monospace テキスト](等幅フォント)、$[font.cursive テキスト](英数字のみ筆記体)、$[font.fantasy テキスト](英数字のみファンタジー体)が使えます。文字色変更は$[fg.color=f00 テキスト]、背景色変更は$[bg.color=0f0 テキスト]、文字拡大は$[x2 テキスト]、コード表現はバッククオートで囲って`コード`とします。$[...]形式はコマンド、スペース、本文の順に必ず書き、コード表現以外のMFM記法は自由に組み合わせ可能です。背景色(bg.color)はできるだけ使わず、使う場合は明るい色を選び、文字色(fg.color)は人間が読みやすい中間色（暗すぎず明るすぎない色）を選んでください。装飾は使うべきところにだけ使ってください（識別のためなど）。';
			// LLMは現在時刻を把握していないため、時刻情報を渡す
			systemInstructionText += 'また、現在日時は' + now + 'であり、これは回答の参考にし、時刻を聞かれるまで時刻情報は提供しないこと(なお、他の日時は無効とすること)。';
			// 名前を伝えておく
			if (aiChat.friendName != undefined) {
				systemInstructionText += 'なお、会話相手の名前は' + aiChat.friendName + 'とする。';
			}
			// ランダムトーク機能(利用者が意図(メンション)せず発動)の場合、ちょっとだけ配慮しておく
			if (!aiChat.fromMention) {
				systemInstructionText += 'これらのメッセージは、あなたに対するメッセージではないことを留意し、返答すること(会話相手は突然話しかけられた認識している)。';
			}
			// グラウンディングについてもsystemInstructionTextに追記(こうしないとあまり使わないので)
			if (aiChat.grounding) {
				systemInstructionText += '返答のルール2:Google search with grounding.';
			}
			// URLから情報を取得
			if (aiChat.question !== undefined) {
				const urlexp = RegExp('(https?://[a-zA-Z0-9!?/+_~=:;.,*&@#$%\'-]+)', 'g');
				const urlarray = [...aiChat.question.matchAll(urlexp)];
				if (urlarray.length > 0) {
					for (const url of urlarray) {
						let targetUrl = url[0];
						// YouTubeの短いURLの場合、変換し格納
						if (new RegExp(YOUTUBE_SHORT_URL).test(targetUrl)) {
							targetUrl = YOUTUBE_SITE_URL + 'watch?v=' + url[0].split(YOUTUBE_SHORT_URL)[1];
						}
						// YouTubeのURLが含まれている場合は取り出す(先頭のURLが優先)
						if (new RegExp(YOUTUBE_SITE_URL).test(targetUrl) && youtubeUrl.length == 0) {
							this.log('YouTube URL Detected!:' + targetUrl);
							youtubeUrl = targetUrl;
						} else {
							this.log('URL:' + targetUrl);
						}
						let result: unknown = null;
						try{
							result = await urlToJson(targetUrl);
						} catch (err: unknown) {
							systemInstructionText += '補足として提供されたURLは無効でした:URL=>' + targetUrl;
							this.log('Skip url because error in urlToJson');
							continue;
						}
						const urlpreview: UrlPreview = result as UrlPreview;
						if (urlpreview.title) {
							systemInstructionText +=
								'補足として提供されたURLの情報は次の通り:URL=>' + urlpreview.url
								+'サイト名('+urlpreview.sitename+')、';
							if (!urlpreview.sensitive) {
								systemInstructionText +=
								'タイトル('+urlpreview.title+')、'
								+ '説明('+urlpreview.description+')、'
								+ '質問にあるURLとサイト名・タイトル・説明を組み合わせ、回答の参考にすること。'
								;
								this.log('urlpreview.sitename:' + urlpreview.sitename);
								this.log('urlpreview.title:' + urlpreview.title);
								this.log('urlpreview.description:' + urlpreview.description);
							} else {
								systemInstructionText +=
								'これはセンシティブなURLの可能性があるため、質問にあるURLとサイト名のみで、回答の参考にすること(使わなくても良い)。'
								;
							}
						} else {
							// 多分ここにはこないが念のため
							this.log('urlpreview.title is nothing');
						}
					}
				}
			}
		} else {
			// 記憶整理
			systemInstructionText = 'ユーザーごとの記憶を効率よく管理するのがあなたの役割です。できるだけ短く、要約して記憶を整理してください。';
		}
		const systemInstruction: GeminiSystemInstruction = {role: 'system', parts: [{text: systemInstructionText}]};

		parts = [{text: aiChat.question}];
		// ファイルが存在する場合、ファイルを添付して問い合わせ
		if (files.length >= 1) {
			for (const file of files){
				parts.push(
					{
						inlineData: {
							mimeType: file.type,
							data: file.base64,
						},
					}
				);
			}
		}
		// YouTube動画のURLを指定。2025年4月29日時点の転載。最新情報は <https://ai.google.dev/gemini-api/docs/video-understanding?hl=ja>
		// ** プレビュー: YouTube URL 機能はプレビュー版で、無料でご利用いただけます。料金とレート制限は変更される可能性があります。 **
		// * 1 日にアップロードできる YouTube 動画は 8 時間までです。
    // * リクエストごとにアップロードできる動画は 1 本のみです。
		// * アップロードできるのは公開動画のみです（非公開動画や限定公開動画はアップロードできません）。
		if (youtubeUrl.length > 0) {
			parts.push(
				{
					fileData: {
						fileUri: youtubeUrl,
					},
				}
			);
		}

		// 履歴を追加
		let contents: GeminiContents[] = [];
		if (aiChat.history != null) {
			aiChat.history.forEach(entry => {
				contents.push({
					role : entry.role,
					parts: [{text: entry.content}],
				});
			});
		}
		contents.push({role: 'user', parts: parts});

		let geminiOptions:GeminiOptions = {
			contents: contents,
			systemInstruction: systemInstruction,
		};
		// gemini api grounding support. ref:https://github.com/google-gemini/cookbook/blob/09f3b17df1751297798c2b498cae61c6bf710edc/quickstarts/Search_Grounding.ipynb
		if (aiChat.grounding) {
			geminiOptions.tools = [{google_search:{}}];
		}
		let options: CallGeminiOptions = {
			url: aiChat.api,
			searchParams: {
				key: aiChat.key,
			},
			json: geminiOptions,
		};

		this.log(JSON.stringify(options));
		let responseText:string = await this.genTextByGeminiCore(options);
		// 結果が空文字だった場合、Gemini 2.0 Flashで再実行
		if (responseText === '') {
			this.log('一度エラーになったので、GEMINI_20_FLASH_APIで再実行');
			options.url = GEMINI_20_FLASH_API;
			responseText = await this.genTextByGeminiCore(options);
		}
		return responseText;
	}

	@bindThis
	private async genTextByGeminiCore(options: CallGeminiOptions) {
		let responseText: string = '';
		try {
			let res_data: any = null;
			res_data = await got.post({
				url: options.url,
				searchParams: options.searchParams,
				json: options.json,
				parseJson: (res: string) => JSON.parse(res)
			}).json();
			this.log(JSON.stringify(res_data));
			const parts = res_data?.candidates?.[0]?.content?.parts;
			if (Array.isArray(parts) && parts.length > 0) {
				for (let i = 0; i < parts.length; i++) {
					// 思考過程を出力したやつの場合、無視
					if (parts[i]?.thought === 'true') continue;
					const text = parts[i]?.text;
					// 先頭から末尾が数字と英字で表現できる内容の場合は無視する(LLMのレスポンスがおかしいため)
					if (typeof text === 'string' && !/^[0-9a-zA-Z]+$/.test(text)) {
						if (i > 0) responseText += '\n...\n\n';
						responseText += text;
					}
					// LLMが気を利かせてよくわからない参考をつけている場合は削除
					if (/\n参考\(1\)/.test(responseText)) {
						responseText = responseText.split('\n参考(1)')[0];
						this.log('**LLMが気を利かせてよくわからない参考をつけているので削除**\n' + responseText.replaceAll(/\n/g, '<br>'));
					}
					// 長すぎるパターンはここで短くしておく
					if (responseText.length > 2000) {
						responseText = responseText.slice(0, 2000) + '(...省略されました...)';
						this.log('長すぎたため、途中から省略:' + responseText.replaceAll(/\n/g, '<br>'));
					}
				}
			}
			// groundingMetadataを取得
			let groundingMetadata = '';
			// 参考サイト情報について処理
			const groundingChunks = res_data?.candidates?.[0]?.groundingMetadata?.groundingChunks;
			if (Array.isArray(groundingChunks)) {
				let checkMaxLength = groundingChunks.length;
				// 参考サイトが多すぎる場合があるので、3つに制限
				if (checkMaxLength > 3) checkMaxLength = 3;
				if (responseText.length + groundingMetadata.length > 2600) {
					groundingMetadata += '参考リンクは省略';
				} else if (responseText.length + groundingMetadata.length > 2400 && checkMaxLength == 3) {
					checkMaxLength = 1;
				} else if (responseText.length + groundingMetadata.length > 2000 && checkMaxLength == 3) {
					checkMaxLength = 2;
				}
				for (let i = 0; i < checkMaxLength; i++) {
					const web = groundingChunks[i]?.web;
					if (web?.uri && web?.title) {
						// 300文字を超えないリンクの場合のみ載せる
						if (web.uri.length < 300) {
							groundingMetadata += `参考(${i + 1}): [${web.title}](${web.uri})\n`;
						} else {
							groundingMetadata += `参考(${i + 1}): ${web.title}(リンクなし)\n`;
						}
					}
				}
			}
			// 検索ワードについて処理
			const webSearchQueries = res_data?.candidates?.[0]?.groundingMetadata?.webSearchQueries;
			if (Array.isArray(webSearchQueries) && webSearchQueries.length > 0) {
				groundingMetadata += '検索ワード: ' + webSearchQueries.join(',') + '\n';
			}
			if (groundingMetadata) {
				responseText += '\n' + groundingMetadata;
			}
		} catch (err: unknown) {
			this.log('Error By Call Gemini');
			if (err instanceof HTTPError) {
				// HTTPErrorの場合、レスポンスのボディを取得
				this.log(`HTTP Error: ${err.response.statusCode} ${err.response.statusMessage}`);
				// レスポンスのボディからエラーメッセージを取得
				if (err.response.body) {
					let responseText = err.response.body.toString();
					try {
						const errorData = JSON.parse(responseText);
						if (errorData.error && errorData.error.message) {
							responseText = errorData.error.message;
						}
					} catch (jsonErr) {
						this.log('Failed to parse error response as JSON');
					}
					this.log(`Response Body: ${responseText}`);
				}
			} else if (err instanceof Error) {
				this.log(`${err.name}\n${err.message}\n${err.stack}`);
			}
		}
		return responseText;
	}

	@bindThis
	private async genTextByPLaMo(aiChat: AiChat) {
		this.log('Generate Text By PLaMo...');

		let options = {
			url: aiChat.api,
			headers: {
				Authorization: 'Bearer ' + aiChat.key
			},
			json: {
				model: 'plamo-2.0-prime',
				messages: [
					{ role: 'system', content: aiChat.prompt },
					{ role: 'user', content: aiChat.question },
				],
			},
		};
		this.log(JSON.stringify(options));
		let res_data: any = null;
		try {
			res_data = await got.post({
				url: options.url,
				headers: options.headers,
				json: options.json,
				parseJson: (res: string) => JSON.parse(res)
			}).json();
			this.log(JSON.stringify(res_data));
			return res_data?.choices?.[0]?.message?.content ?? null;
		} catch (err: unknown) {
			this.log('Error By Call PLaMo');
			if (err instanceof Error) {
				this.log(`${err.name}\n${err.message}\n${err.stack}`);
			}
		}
		return null;
	}

	@bindThis
	private async note2base64File(notesId: string) {
		const noteData = await this.ai.api('notes/show', { noteId: notesId }) as { files?: any[] };
		let files: base64File[] = [];
		if (noteData?.files && Array.isArray(noteData.files)) {
			for (let i = 0; i < noteData.files.length; i++) {
				let fileType = noteData.files[i]?.type;
				if (noteData.files[i]?.name) {
					if (fileType === 'application/octet-stream' || fileType === 'application/xml') {
						fileType = 'text/plain';
					}
				}
				let filelUrl = noteData.files[i]?.thumbnailUrl || noteData.files[i]?.url;
				if (fileType && filelUrl) {
					try {
						this.log('filelUrl:' + filelUrl);
						const file = await urlToBase64(filelUrl);
						const base64file: base64File = { type: fileType, base64: file };
						files.push(base64file);
					} catch (err: unknown) {
						if (err instanceof Error) {
							this.log(`${err.name}\n${err.message}\n${err.stack}`);
						}
					}
				}
			}
		}
		return files;
	}

	@bindThis
	private async mentionHook(msg: Message) {
		if (!msg.includes([this.name])) {
			return false;
		} else {
			this.log('AiChat requested');
		}

		// msg.idをもとにnotes/conversationを呼び出し、会話中のidかチェック
		const conversationData = await this.ai.api('notes/conversation', { noteId: msg.id });

		// aichatHistに該当のポストが見つかった場合は会話中のためmentionHoonkでは対応しない
		let exist : AiChatHist | null | undefined;
		if (Array.isArray(conversationData)) {
			for (const message of conversationData) {
				exist = this.aichatHist?.findOne({
					postId: message.id
				});
				if (exist) return false;
			}
		}

		// タイプを決定
		let type = TYPE_GEMINI;
		if (msg.includes([KIGO + TYPE_GEMINI])) {
			type = TYPE_GEMINI;
		} else if (msg.includes([KIGO + 'chatgpt4'])) {
			type = 'chatgpt4';
		} else if (msg.includes([KIGO + 'chatgpt'])) {
			type = 'chatgpt3.5';
		} else if (msg.includes([KIGO + TYPE_PLAMO])) {
			type = TYPE_PLAMO;
		}
		const current : AiChatHist = {
			postId: msg.id,
			createdAt: Date.now(),// 適当なもの
			type: type,
			fromMention: true,
		};
		// 引用している場合、情報を取得しhistoryとして与える
		if (msg.quoteId) {
			const quotedNote = await this.ai.api('notes/show', {
				noteId: msg.quoteId,
			}) as { text?: string };
			current.history = [
				{
					role: 'user',
					content:
						'ユーザーが与えた前情報である、引用された文章: ' +
						(quotedNote.text ?? ''),
				},
			];
		}
		// AIに問い合わせ
		const result = await this.handleAiChat(current, msg);

		if (result) {
			return {
				reaction: 'like'
			};
		}
		return false;
	}

	@bindThis
	private async contextHook(key: any, msg: Message) {
		this.log('contextHook...');
		if (msg.text == null) return false;

		// msg.idをもとにnotes/conversationを呼び出し、該当のidかチェック
		const conversationData = await this.ai.api('notes/conversation', { noteId: msg.id });

		// 結果がnullやサイズ0の場合は終了
		if (!Array.isArray(conversationData) || conversationData.length == 0 ) {
			this.log('conversationData is nothing.');
			return false;
		}

		// aichatHistに該当のポストが見つからない場合は終了
		let exist : AiChatHist | null | undefined;
		if (Array.isArray(conversationData)) {
			for (const message of conversationData) {
				exist = this.aichatHist?.findOne({
					postId: message.id
				});
				// 見つかった場合はそれを利用
				if (exist) break;
			}
		}
		if (!exist) {
			this.log('conversationData is not found.');
			return false;
		}
		this.log(exist.type + ':' + exist.postId);
		// if (exist.history) {
		// 	for (const his of exist.history) {
		// 		this.log(his.role + ':' + his.content);
		// 	}
		// }

		// AIに問い合わせ
		const result = await this.handleAiChat(exist, msg);

		// 問い合わせ結果が適切な場合、unsubscribe&removeし、回答。今回のでsubscribe,insert,timeout設定
		this.log('unsubscribeReply & remove.');
		this.unsubscribeReply(key);
		this.aichatHist?.remove(exist);

		if (result) {
			return {
				reaction: 'like'
			};
		}
		return false;
	}

	@bindThis
	private async aichatRandomTalk() {
		this.log('AiChat(randomtalk) started');
		const tl = await this.ai.api('notes/local-timeline', {
			limit: 30
		});
		if (!Array.isArray(tl)) {
			this.log('local-timeline result is not an array.');
			return false;
		}
		const interestedNotes = tl.filter(note =>
			note.userId !== this.ai.account.id &&
			note.text != null &&
			note.replyId == null &&
			note.renoteId == null &&
			note.cw == null &&
			note.files.length == 0 &&
			!note.user.isBot
		);

		// 対象が存在しない場合は処理終了
		if (interestedNotes == undefined || interestedNotes.length == 0) return false;

		// ランダムに選択
		const choseNote = interestedNotes[Math.floor(Math.random() * interestedNotes.length)];

		// aichatHistに該当のポストが見つかった場合は会話中のためaichatRandomTalkでは対応しない
		let exist : AiChatHist | undefined | null;

		// 選択されたノート自体が会話中のidかチェック
		exist = this.aichatHist?.findOne({
			postId: choseNote.id
		});
		if (exist) return false;

		// msg.idをもとにnotes/childrenを呼び出し、会話中のidかチェック
		const childrenData = await this.ai.api('notes/children', { noteId: choseNote.id });
		if (Array.isArray(childrenData)) {
			for (const message of childrenData) {
				exist = this.aichatHist?.findOne({
					postId: message.id
				});
				if (exist) return false;
			}
		}

		// msg.idをもとにnotes/conversationを呼び出し、会話中のidかチェック
		const conversationData = await this.ai.api('notes/conversation', { noteId: choseNote.id });
		if (Array.isArray(conversationData)) {
			for (const message of conversationData) {
				exist = this.aichatHist?.findOne({
					postId: message.id
				});
				if (exist) return false;
			}
		}

		// 確率をクリアし、親愛度が指定以上、かつ、Botでない場合のみ実行
		if (Math.random() < this.randomTalkProbability) {
			this.log('AiChat(randomtalk) targeted: ' + choseNote.id);
		} else {
			this.log('AiChat(randomtalk) is end.');
			return false;
		}
		const friend: Friend | null = this.ai.lookupFriend(choseNote.userId);
		if (friend == null || friend.love < 2) {
			this.log('AiChat(randomtalk) end.Because there was not enough affection.');
			return false;
		} else if (choseNote.user.isBot) {
			this.log('AiChat(randomtalk) end.Because message author is bot.');
			return false;
		}

		const current : AiChatHist = {
			postId: choseNote.id,
			createdAt: Date.now(),// 適当なもの
			type: TYPE_GEMINI,		// 別のAPIをデフォルトにしてもよい
			fromMention: false,		// ランダムトークの場合はfalseとする
		};
		// AIに問い合わせ
		let targetedMessage = choseNote;
		if (choseNote.extractedText == undefined) {
			const data = await this.ai.api('notes/show', { noteId: choseNote.id });
			targetedMessage = new Message(this.ai, data);
		}
		const result = await this.handleAiChat(current, targetedMessage);

		if (result) {
			return {
				reaction: 'like'
			};
		}
		return false;
	}

	// ユーザーの記憶を取得
	private getUserMemory(userId: string): string[] {
		const mem = this.aichatMemory?.findOne({ userId });
		return mem?.memory ?? [];
	}

	// 古い記憶をAIで要約する
	private async summarizeMemoryAI(userId: string): Promise<string[]> {
		const mem = this.aichatMemory?.findOne({ userId });
		if (!mem || mem.memory.length <= MEMORY_MAX) return mem?.memory ?? [];
		const memoryText = mem.memory.join('\n');
		const prompt = `
あなたは藍とは別の存在であり、藍とユーザーの会話を整理する記憶管理AIです。以下は過去の記憶です。\n
---\n
${memoryText}\n
---\n
この記憶を、重要な点(ユーザーとの約束、ユーザーが気になっているもの(好み)、気にした場所など)だけ残して箇条書きで要約してください。AIの挙動や重要でない情報は大胆に省略して構いません。
`;
		let summary: string = '';
		// Gemini優先、なければPLaMo
		if (config.geminiProApiKey) {
			const aiChat: AiChat = {
				question: prompt,
				prompt: '',
				api: GEMINI_25_FLASH_API,
				key: config.geminiProApiKey,
				history: [],
				fromMention: true // 要約はメンションから来たものとする
			};
			summary = await this.genTextByGemini(aiChat, [], true);
		} else if (config.pLaMoApiKey) {
			const aiChat: AiChat = {
				question: prompt,
				prompt: '',
				api: PLAMO_API,
				key: config.pLaMoApiKey,
				history: [],
				fromMention: true // 要約はメンションから来たものとする
			};
			summary = await this.genTextByPLaMo(aiChat) ?? '';
		}
		if (summary && summary.trim().length > 0) {
			return summary.split('\n').map(m => m.trim()).filter(m => m.length > 0);
		} else {
			this.log('AIによる要約に失敗しました。直近の記憶のみを残します。');
			return mem.memory.slice(-MEMORY_MAX); // 要約失敗時は直近だけ残す
		}
	}

	// ユーザーの記憶に追加（AI要約処理付き）
	private async addUserMemory(userId: string, text: string) {
		const normizeText = text.trim().replace(/\$\[\w+\.?\w* (.+?)\]/g, '$1').replace('[', '「').replace(']', '」').replace(/"'/g, '“'); // MFMのフォント記法を正規化
		let mem = this.aichatMemory?.findOne({ userId });
		if (!mem) {
			mem = this.aichatMemory?.insertOne({ userId, memory: [] });
		}
		mem?.memory.push(normizeText);
		// 純粋記憶数を超過した場合、AI要約処理を行う
		if (mem){
			if(mem.memory.length > MEMORY_MAX) {
				this.log(`${userId}: User memory exceeded the limit. Summarizing...`);
				mem.memory = await this.summarizeMemoryAI(userId);
			}
			this.aichatMemory?.update(mem);
		}
	}

	@bindThis
	private async handleAiChat(exist: AiChatHist, msg: Message) {
		let text: string | null, aiChat: AiChat;
		let prompt: string = '';
		if (config.prompt) {
			prompt = config.prompt;
		}
		const reName = RegExp(this.name, 'i');
		let reKigoType = RegExp(KIGO + exist.type, 'i');
		const extractedText = msg.extractedText;
		if (extractedText == undefined || extractedText.length == 0) return false;

		// Gemini API用にAPIのURLと置き換え用タイプを変更
		if (msg.includes([KIGO + GEMINI_FLASH])) {
			exist.api = GEMINI_25_FLASH_API;
			reKigoType = RegExp(KIGO + GEMINI_FLASH, 'i');
		} else if (msg.includes([KIGO + GEMINI_PRO])) {
			exist.api = GEMINI_25_PRO_API;
			reKigoType = RegExp(KIGO + GEMINI_PRO, 'i');
		}

		// groudingサポート
		if (msg.includes([GROUNDING_TARGET])) {
			exist.grounding = true;
		}
		// 設定で、デフォルトgroundingがONの場合、メンションから来たときは強制的にgroundingをONとする(ランダムトークの場合は勝手にGoogle検索するのちょっと気が引けるため...)
		if (exist.fromMention && config.aichatGroundingWithGoogleSearchAlwaysEnabled) {
			exist.grounding = true;
		}

		const friend: Friend | null = this.ai.lookupFriend(msg.userId);
		let friendName: string | undefined;
		if (friend != null && friend.name != null) {
			friendName = friend.name;
		} else if (msg.user.name) {
			friendName = msg.user.name;
		} else {
			friendName = msg.user.username;
		}

		const question = extractedText
							.replace(reName, '')
							.replace(reKigoType, '')
							.replace(GROUNDING_TARGET, '')
							.trim();

		// ここで記憶を取得し、プロンプトに追加
		const userMemory = this.getUserMemory(msg.userId);
		if (userMemory.length > 0) {
			prompt += `\n【あなたの記憶】: ${userMemory.join('\n')}\n`;
		}
		switch (exist.type) {
			case TYPE_GEMINI:
				// geminiの場合、APIキーが必須
				if (!config.geminiProApiKey) {
					msg.reply(serifs.aichat.nothing(exist.type));
					return false;
				}
				const base64Files: base64File[] = await this.note2base64File(msg.id);
				aiChat = {
					question: question,
					prompt: prompt,
					api: GEMINI_25_FLASH_API,
					key: config.geminiProApiKey,
					history: exist.history,
					friendName: friendName,
					fromMention: exist.fromMention
				};
				if (exist.api) {
					aiChat.api = exist.api;
				}
				if (exist.grounding) {
					aiChat.grounding = exist.grounding;
				}
				text = await this.genTextByGemini(aiChat, base64Files);
				break;

			case TYPE_PLAMO:
				// PLaMoの場合、APIキーが必須
				if (!config.pLaMoApiKey) {
					msg.reply(serifs.aichat.nothing(exist.type));
					return false;
				}
				aiChat = {
					question: msg.text,
					prompt: prompt,
					api: PLAMO_API,
					key: config.pLaMoApiKey,
					history: exist.history,
					friendName: friendName,
					fromMention: exist.fromMention
				};
				text = await this.genTextByPLaMo(aiChat);
				break;

			default:
				msg.reply(serifs.aichat.nothing(exist.type));
				return false;
		}

		if (text == null || text == '') {
			this.log('The result is invalid. It seems that tokens and other items need to be reviewed.')
			msg.reply(serifs.aichat.error(exist.type));
			return false;
		}
		// 後処理(AIが苦手そうなところをサポート)
		const processedText: string = this.postProcess(text);

		this.log('Replying...');
		let replyId:string = '';
		// フォロワー限定投稿の場合もDMで返信しておく
		if (msg.visibility == "followers") {
			const postData = {
				replyId: msg.id,
				text: serifs.aichat.post(processedText, exist.type),
			};
			const reply: Message|undefined = await this.ai.sendMessage(msg.userId, postData);
			if (reply?.id) {
				replyId = reply.id
			}
		} else {
			const reply: Message|undefined = await msg.reply(serifs.aichat.post(processedText, exist.type));
			if (reply?.id) {
				replyId = reply.id
			}
		}
		this.log('replyId:' + replyId);

		// 履歴に登録
		if (!exist.history) {
			exist.history = [];
		}
		exist.history.push({ role: 'user', content: question });
		exist.history.push({ role: 'model', content: processedText });
		// 履歴が10件を超えた場合、古いものを削除
		if (exist.history.length > 10) {
			exist.history.shift();
		}
		this.aichatHist?.insertOne({
			postId: replyId,
			createdAt: Date.now(),
			type: exist.type,
			api: aiChat.api,
			history: exist.history,
			grounding: exist.grounding,
			fromMention: exist.fromMention,
		});

		this.log('Subscribe&Set Timer...');

		// メンションをsubscribe
		this.subscribeReply(replyId, replyId);

		// タイマーセット
		this.setTimeoutWithPersistence(TIMEOUT_TIME, {
			id: replyId
		});

		// --- ここでAIに新しい記憶を生成させて保存 ---
		// AIに「今までの記憶」「今回の質問」「今回の回答」を渡し、「新しい記憶」を生成するよう依頼
		this.log('Updating memory...');
		const memoryPrompt = `
あなたはユーザーの記憶管理AIです。以下は今までの記憶です。
${userMemory.join('\n')}
今回の質問: ${question}
今回の回答: ${processedText}
これらを踏まえて、今後の会話に役立つように記憶をアップデートしてください(URLは記録不要、AIができることも記録不要(できることが増える可能性があるため)、ユーザーがどういう人物か、自分がどういう雰囲気を求められているかを重点的に記憶するように)。
`;
		let newMemory: string = '';
		switch (exist.type) {
			case TYPE_GEMINI:
				// Gemini APIで記憶生成
				if (!config.geminiProApiKey) {
					return false;
				}
				const memoryAiChat: AiChat = {
					question: memoryPrompt,
					prompt: '',
					api: GEMINI_25_FLASH_API,
					key: config.geminiProApiKey,
					history: [],
					friendName: friendName,
					fromMention: true // 記憶の生成はメンションから来たものとする
				};
				newMemory = await this.genTextByGemini(memoryAiChat, [], true) ?? '';
				break;
			case TYPE_PLAMO:
				if (!config.pLaMoApiKey) {
					return false;
				}
				const memoryAiChatPlamo: AiChat = {
					question: memoryPrompt,
					prompt: '',
					api: PLAMO_API,
					key: config.pLaMoApiKey,
					history: [],
					friendName: friendName,
					fromMention: true // 記憶の生成はメンションから来たものとする
				};
				newMemory = await this.genTextByPLaMo(memoryAiChatPlamo) ?? '';
				break;
			default:
				break;
		}
		// 新しい記憶を保存
		if (newMemory && newMemory.trim().length > 0) {
			await this.addUserMemory(msg.userId, newMemory);
		}

		return true;
	}

	@bindThis
	private postProcess(message: string) {
		// Misskeyで破壊されがちなMarkdownのリスト記法について対処
		message = message.replaceAll(/^(\s*)\* */g, '$1・');

		// 絵文字部分について対処
		const matchesEmoji = [...message.matchAll(/:(.*?):/g)];
		matchesEmoji.forEach(match => {
			// :で囲われた中の\はたぶんおかしいので変換
			const fixed = match[1].replaceAll(/\\/g,'');
			message.replace(match[1], fixed);
		});
		// MFMについて対処
		message = message
			.replaceAll(/\]\$/g, ']')// よくわからないが
			.replaceAll(/\}\[font/g, '$[font')// fontの開始ミスを訂正
			.replaceAll(/([^$])\[font/g, '$1$[font')// fontの開始ミスを訂正
			.replaceAll(/\$\[\$font/g, '$[font')// fontの開始ミスを訂正2
			.replaceAll(/ font\]/g, ' ')// fontの使い方の勘違いを訂正
			.replaceAll(/\$\[fg\.color=\w{3,} \]/g, '')// 何も文字がないものは削除
			.replaceAll(/\$$/g, '')// 末尾の$マークはなにかのミスと思われるため削除
			.replaceAll(/[\}\]]\$ /g, ']')// "}$ "や"]$"も]のミスだと思われる...
			.replaceAll(/>\[(\w{2}).color/g, '$[$1.color')// colorの指定ミスを訂正
			.replaceAll(/\${2,}/g, '')// $が2つ以上続くのはミス
			.replaceAll(/\$\./g, '')// $.はたぶんミス
			.replaceAll(/\$\]/g, ']')// "$]"を訂正
			.replaceAll(/\\text\{(.+?)\}/ig, '$1')// 謎の\text{xxx}構文を削除
			.replaceAll(/。,+/ig, '。')// 。のあとの,連続について補正
			.replaceAll(/\$\[fg\.color=#([a-f0-9]{3} .+?)\]/g, '$[fg.color=$1 ]')// fg.colorで#がついちゃうやつ
			.replaceAll(/XXXXXXXXXXXX/g, '');
		return message;
	}

	@bindThis
	private async timeoutCallback({id}) {
		this.log('timeoutCallback...');
		const exist = this.aichatHist?.findOne({
			postId: id
		});
		this.unsubscribeReply(id);
		if (exist != null) {
			this.aichatHist?.remove(exist);
		}
	}
}
