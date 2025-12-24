import { bindThis } from '@/decorators.js';
import loki from 'lokijs';
import Module from '@/module.js';
import Message from '@/message.js';
import serifs from '@/serifs.js';
import type { User } from '@/misskey/user.js';
import { acct } from '@/utils/acct.js';
import fs from 'fs';
import path from 'path';
import chalk from 'chalk';

// プレイヤー情報
type Player = {
	id: string;
	username: string;
	host: User['host'];
	points: number;
	hand: string[]; // 手札の回答カード
	hasAnswered: boolean; // そのターンで回答済みか
};

// 場に出された回答
type FieldAnswer = {
	card: string; // 回答カードのテキスト
	playerId: string; // 'dummy' の場合は山札からのダミー
};

// data/ohgiri.json の型
type OhgiriData = {
	subject: string[]; // お題の配列
	answer: string[]; // 回答カードの配列
};

// ゲーム全体の状況
type Game = {
	players: Player[];
	isEnded: boolean;
	startedAt: number;
	postId: string; // ゲームの親投稿ID (募集告知、全体通知用)
	state: 'waiting-for-players' | 'answering' | 'choosing'; // ゲームの進行状態
	currentOdai: string; // 現在のお題
	field: FieldAnswer[]; // 場に出された回答
	houseId: string | null; // 現在の親のプレイヤーID
	turn: number;
	winPoints: number; // 勝利に必要なポイント
	history: {
		turn: number;
		odai: string;
		answers: { card: string; player: Player | null }[]; // playerがnullならダミー
		chosen: FieldAnswer;
	}[];
	answerDeck: string[]; // 回答カードの山札
	activeReactionNoteId: string | null; // 現在リアクションを監視している投稿ID
};

const MINIMUM_PLAYERS = 2; // 最低参加人数(3人以上を推奨)
const GAME_END_POINTS = 2; // ゲーム終了に必要なポイント
const HANDS_SIZE = 3; // 手札の枚数(10枚以下じゃないとおかしくなる)
const WAIT_TIME_FOR_PLAYERS = 1000 * 60 * 1; // 参加者募集時間: 1分
const GAME_TIME_LIMIT = 1000 * 60 * 10; // ゲーム全体の制限時間: 10分

export default class extends Module {
	public readonly name = 'ohgiri';

	private ohgiriGames!: loki.Collection<Game>;
	private ohgiriData: OhgiriData = {
		subject: [],
		answer: []
	};

	@bindThis
	public install() {
		const dataFilePath = path.resolve('data/ohgiri.json');
		this.log(chalk.greenBright(`[Ohgiri:install] Loading ohgiri data from ${dataFilePath}`));
		this.ohgiriData = JSON.parse(fs.readFileSync(dataFilePath, 'utf-8'));
		this.ohgiriGames = this.ai.getCollection('ohgiri');
		setInterval(this.crawleGameEnd, 5000);

		return {
			mentionHook: this.mentionHook,
			contextHook: this.contextHook,
			reactionHook: this.reactionHook,
		};
	}

	// 「大喜利」メンションでゲームの準備を開始
	@bindThis
	private async mentionHook(msg: Message) {
		if (!msg.includes(['大喜利','ohgiri','おーぎり','おおぎり','オーギリ'])) return false;

		// アクティブなゲームがないかチェック
		const existingGame = this.ohgiriGames.findOne({ isEnded: false });
		if (existingGame) {
			msg.reply(serifs.ohgiri.alreadyStarted, { renote: existingGame.postId });
			return true;
		}

		// ゲーム開始を告知し、参加者を募集
		const post = await this.ai.post({
			text: serifs.ohgiri.intro(Math.floor(WAIT_TIME_FOR_PLAYERS / 1000 / 60), MINIMUM_PLAYERS),
		});

		// ゲームオブジェクトをDBに作成
		const newGame: Game = {
			players: [],
			isEnded: false,
			startedAt: Date.now(),
			postId: post.id,
			state: 'waiting-for-players',
			currentOdai: '',
			field: [],
			houseId: null,
			turn: 0,
			winPoints: GAME_END_POINTS,
			history: [],
			answerDeck: [...this.ohgiriData.answer].sort(() => Math.random() - 0.5),
			activeReactionNoteId: post.id, // 初期募集投稿を監視対象とする
		};
		this.ohgiriGames.insertOne(newGame);

		this.log(chalk.greenBright('New ohgiri game created. Waiting for players...'));
		// 募集投稿へのリプライ/リアクションを監視
		this.ai.subscribeReply(this, 'game-setup', post.id);

		// 一定時間後にゲームを開始するタイマーをセット
		setTimeout(() => this.startGame(post.id), WAIT_TIME_FOR_PLAYERS);

		return true;
	}

	// 参加希望者のリプライを処理
	@bindThis
	private async contextHook(key: any, msg: Message) {
		const game = this.ohgiriGames.findOne({ isEnded: false });

		// 参加者募集中の状態で、募集投稿へのリプライが「参加」であればプレイヤー登録
		if (game && game.state === 'waiting-for-players' && key === 'game-setup' && msg.text && msg.text.includes('参加')) {
			if (game.players.some(p => p.id === msg.userId)) {
				return { reaction: 'confused' }; // 既に参加済み
			}

			this.log(chalk.greenBright(`Player joined: ${acct(msg.user)}`));
			game.players.push({
				id: msg.userId,
				username: msg.user.username,
				host: msg.user.host,
				points: 0,
				hand: [],
				hasAnswered: false,
			});
			this.ohgiriGames.update(game);
			return { reaction: 'like' };
		}
		return;
	}

	// 募集時間終了後、ゲーム本編を開始
	@bindThis
	private async startGame(postId: string) {
		const game = this.ohgiriGames.findOne({ postId });
		if (!game || game.state !== 'waiting-for-players') return;

		// 募集フェーズのコンテキストを解除
		this.ai.unsubscribeReply(this, 'game-setup');

		if (game.players.length < MINIMUM_PLAYERS) {
			this.ai.post({ renoteId: game.postId, text: serifs.ohgiri.notEnoughPlayers(MINIMUM_PLAYERS - 1)});
			game.isEnded = true;
			this.ohgiriGames.update(game);
			this.log(chalk.redBright('Ohgiri game aborted due to lack of players.'));
			return;
		}

		this.log(chalk.greenBright('Starting ohgiri game!'));

		// 最初の親をランダムに決定
		game.houseId = game.players[Math.floor(Math.random() * game.players.length)].id;

		// 全員に手札を配る
		game.players.forEach(p => this.drawCards(game, p, HANDS_SIZE));

		await this.ai.post({
			renoteId: game.postId,
			text: serifs.ohgiri.gameStart(game.players.map(p => acct(p)).join(', '), GAME_END_POINTS),
		});

		this.startTurn(game);
	}

	// 新しいターンを開始
	@bindThis
	private async startTurn(game: Game) {
		game.turn++;
		game.state = 'answering';
		game.field = [];
		game.players.forEach(p => p.hasAnswered = false);

		game.currentOdai = this.ohgiriData.subject[Math.floor(Math.random() * this.ohgiriData.subject.length)];
		const house = game.players.find(p => p.id === game.houseId)!;

		this.log(chalk.greenBright(`Turn ${game.turn} started. Odai: ${game.currentOdai}, House: ${house.username}`));

		// 前の監視対象投稿があれば、そのコンテキストを解除
		if (game.activeReactionNoteId) {
			const oldContext = this.ai.db.getCollection('contexts').findOne({ noteId: game.activeReactionNoteId, module: this.name });
			if (oldContext && oldContext.key) {
				this.ai.unsubscribeReply(this, oldContext.key);
			}
		}

		const odaiPost = await this.ai.post({
			renoteId: game.postId,
			text: serifs.ohgiri.turnStart(game.turn, game.currentOdai, acct(house)),
		});

		// 新しい「お題」投稿へのリアクションを監視
		const answeringKey = `game-${game.postId}-answering-${game.turn}`;
		this.ai.subscribeReply(this, answeringKey, odaiPost.id);
		game.activeReactionNoteId = odaiPost.id; // 現在の監視対象投稿を更新

		for (const player of game.players) {
			if (player.id !== game.houseId) { // 親以外に手札をDM
				const messageText = serifs.ohgiri.handInfo(player.hand);
				this.ai.sendMessage(player.id, {
					text: messageText,
				});
			}
		}
		this.ohgiriGames.update(game);
	}

	// プレイヤーのリアクションを処理 (回答提出、親の選択)
	@bindThis
	private async reactionHook(reaction: string, user: User, msg: Message) {
		this.log(chalk.greenBright(`reactionHook(ohgiri): ${reaction} from ${acct(user)} on note ${msg.id}`));
		const game = this.ohgiriGames.findOne({ isEnded: false });
		if (!game) {
			this.log(chalk.yellow(`reactionHook(ohgiri): reactionHook called but no active game found.`));
			return;
		}

		// Bot自身のリアクションは無視
		if (user.id === this.ai.account.id) {
			return;
		}

		// 現在監視している投稿IDに対するリアクションのみを処理
		if (msg.id !== game.activeReactionNoteId) {
			this.log(chalk.yellow(`reactionHook(ohgiri): Ignoring reaction on non-active note: ${msg.id}. Active: ${game.activeReactionNoteId}`));
			// 無関係な投稿へのリアクションには「confused」で反応を返す
			this.ai.api('notes/reactions/create', {
				noteId: msg.id,
				reaction: 'confused'
			});
			return;
		}

		// 数字リアクションをインデックスに変換
		const numberEmojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟'];
		let choiceIndex = numberEmojis.indexOf(reaction);
		if (choiceIndex === -1) {
			const numberEmojis2 = ['1⃣', '2⃣', '3⃣', '4⃣', '5⃣', '6⃣', '7⃣', '8⃣', '9⃣', '10⃣'];
			choiceIndex = numberEmojis2.indexOf(reaction);
			// 数字リアクション以外の場合のハンドリング
			if (choiceIndex === -1) {
				this.log(chalk.yellow(`reactionHook(ohgiri): Non-numeric reaction received: ${reaction}. Responding with 'confused'.`));
				// 数字リアクションではないため、confusedでリアクションを返して処理を終了
				this.ai.api('notes/reactions/create', {
					noteId: msg.id,
					reaction: 'confused'
				});
				return; // 数字リアクションではないので、これ以上ゲームロジックは進めない
			}
		}

		this.log(chalk.blue(`[Ohgiri] Numeric reaction received: ${reaction} (${choiceIndex + 1}) by ${user.username} for note ${msg.id}. Game state: ${game.state}.`));

		// ゲーム状態で分岐(回答中,選択中(それ以外はエラー))
		switch (game.state) {
			case 'answering':
				this.handlePlayerAnswer(game, user.id, choiceIndex);
				break;
			case 'choosing':
				this.handleHouseChoice(game, user.id, choiceIndex);
				break;
			default:
					this.log(chalk.yellow(`reactionHook(ohgiri): Unexpected game state for reaction: ${game.state}`));
					this.ai.api('notes/reactions/create', {
							noteId: msg.id,
							reaction: 'confused'
					});
					break;
		}
	}

	// 子の回答を処理
	@bindThis
	private handlePlayerAnswer(game: Game, userId: string, cardIndex: number) {
		this.log(chalk.magenta(`[Ohgiri:handlePlayerAnswer] Called for userId: ${userId}, cardIndex: ${cardIndex}, game state: ${game.state}`));
		this.log(chalk.magenta(`[Ohgiri:handlePlayerAnswer] Current players in game: ${JSON.stringify(game.players.map(p => ({ id: p.id, username: p.username })))}`));
		this.log(chalk.magenta(`[Ohgiri:handlePlayerAnswer] Current houseId: ${game.houseId}`));

		const player = game.players.find(p => p.id === userId);
		this.log(chalk.magenta(`[Ohgiri:handlePlayerAnswer] Found player for userId ${userId}: ${player ? JSON.stringify({ id: player.id, username: player.username }) : 'undefined'}`));

		if (!player) {
			this.log(chalk.red(`[Ohgiri:handlePlayerAnswer ERROR] Player not found for userId: ${userId}. Returning.`));
			this.ai.api('notes/reactions/create', {
				noteId: game.activeReactionNoteId!,
				reaction: 'confused'
			});
			return;
		}

		if (player.id === game.houseId) {
			this.log(chalk.yellow(`[Ohgiri:handlePlayerAnswer WARN] Player ${player.username} is house, cannot answer. Returning.`));
			this.ai.api('notes/reactions/create', {
				noteId: game.activeReactionNoteId!,
				reaction: 'confused'
			});
			return;
		}

		// 一度回答したら変更できない(この仕様でいいのかは要検討)
		if (player.hasAnswered) {
			this.log(chalk.yellow(`[Ohgiri:handlePlayerAnswer WARN] Player ${player.username} has already answered this turn. Returning.`));
			this.ai.api('notes/reactions/create', {
				noteId: game.activeReactionNoteId!,
				reaction: 'confused'
			});
			return;
		}

		if (cardIndex < 0 || cardIndex >= player.hand.length) {
			this.log(chalk.red(`[Ohgiri:handlePlayerAnswer ERROR] Invalid cardIndex ${cardIndex} for player ${player.username}. Hand size: ${player.hand.length}. Returning.`));
			this.ai.api('notes/reactions/create', {
				noteId: game.activeReactionNoteId!,
				reaction: 'confused'
			});
			return;
		}

		// 念のための追加チェック：player.idがundefinedになるはずはないが、万が一のために
		if (player.id === undefined) {
			this.log(chalk.red(`[Ohgiri:handlePlayerAnswer FATAL ERROR] Player found but player.id is undefined for userId: ${userId}. This should not happen. Returning.`));
			this.ai.api('notes/reactions/create', {
				noteId: game.activeReactionNoteId!,
				reaction: 'confused'
			});
			return;
		}

		player.hasAnswered = true;
		const selectedCard = player.hand.splice(cardIndex, 1)[0];

		this.log(chalk.magenta(`[Ohgiri:handlePlayerAnswer] Pushing answer: card=${selectedCard}, playerId=${player.id} to game.field. Current field size: ${game.field.length}`));
		game.field.push({ card: selectedCard, playerId: player.id });
		this.log(chalk.magenta(`[Ohgiri:handlePlayerAnswer] Answer pushed. New field size: ${game.field.length}`));

		this.log(`Answer submitted by ${player.username}: ${selectedCard}`);
		this.ai.api('notes/reactions/create', {
			noteId: game.activeReactionNoteId!,
			reaction: 'sparkle'
		});

		const answeredCount = game.players.filter(p => p.id !== game.houseId && p.hasAnswered).length;
		this.log(chalk.magenta(`[Ohgiri:handlePlayerAnswer] Answered count: ${answeredCount}/${game.players.length - 1} (Excluding house)`));
		if (answeredCount === game.players.length - 1) {
			this.log(chalk.magenta(`[Ohgiri:handlePlayerAnswer] All non-house players have answered. Starting choosing phase.`));
			this.startChoosingPhase(game);
		}
		this.ohgiriGames.update(game);
	}

	// 親の選択フェーズを開始
	@bindThis
	private async startChoosingPhase(game: Game) {
		this.log(chalk.greenBright('[Ohgiri:startChoosingPhase] All answers are in. Starting choosing phase.'));
		game.state = 'choosing';

		const dummyCard = this.drawCards(game, null, 1)[0];
		game.field.push({ card: dummyCard, playerId: 'dummy' });
		this.log(chalk.greenBright(`[Ohgiri:startChoosingPhase] Dummy card "${dummyCard}" added to field. Field size: ${game.field.length}`));

		game.field = game.field.sort(() => Math.random() - 0.5);
		const house = game.players.find(p => p.id === game.houseId)!;

		const choices = game.field.map((ans, i) =>
			`${i + 1}: ${game.currentOdai.replace(/〇〇|××/g, `**${ans.card}**`)}`
		).join('\n');

		// 前の監視対象投稿があれば、そのコンテキストを解除
		if (game.activeReactionNoteId) {
			const oldContext = this.ai.db.getCollection('contexts').findOne({ noteId: game.activeReactionNoteId, module: this.name });
			if (oldContext && oldContext.key) {
				this.ai.unsubscribeReply(this, oldContext.key);
				this.log(chalk.greenBright(`[Ohgiri:startChoosingPhase] Unsubscribed old context for noteId: ${game.activeReactionNoteId}, key: ${oldContext.key}`));
			}
		}

		const choicesPost = await this.ai.post({ renoteId: game.postId, text: serifs.ohgiri.choices(acct(house), choices) });
		this.log(chalk.greenBright(`[Ohgiri:startChoosingPhase] Choices posted (ID: ${choicesPost.id}).`));

		// 新しい「回答の選択肢」投稿へのリアクションを監視
		const choosingKey = `game-${game.postId}-choosing-${game.turn}`;
		this.ai.subscribeReply(this, choosingKey, choicesPost.id);
		game.activeReactionNoteId = choicesPost.id; // 現在の監視対象投稿を更新
		this.log(chalk.greenBright(`[Ohgiri:startChoosingPhase] Subscribed new context for noteId: ${choicesPost.id}, key: ${choosingKey}`));


		this.ohgiriGames.update(game);
	}

	// 親の選択を処理
	@bindThis
	private async handleHouseChoice(game: Game, userId: string, choiceIndex: number) {
		this.log(chalk.cyanBright(`[Ohgiri:handleHouseChoice] Called by userId: ${userId}, choiceIndex: ${choiceIndex}, game state: ${game.state}.`));
		this.log(chalk.cyanBright(`[Ohgiri:handleHouseChoice] Current houseId: ${game.houseId}. Field size: ${game.field.length}.`));
		this.log(chalk.cyanBright(`[Ohgiri:handleHouseChoice] Current field: ${JSON.stringify(game.field.map(f => f.card))}`));

		if (userId !== game.houseId) {
			this.log(chalk.red(`[Ohgiri:handleHouseChoice ERROR] Non-house player ${userId} attempted to choose. HouseId: ${game.houseId}. Returning.`));
			this.ai.api('notes/reactions/create', {
				noteId: game.activeReactionNoteId!,
				reaction: 'confused'
			});
			return;
		}
		if (choiceIndex < 0 || choiceIndex >= game.field.length) {
			this.log(chalk.red(`[Ohgiri:handleHouseChoice ERROR] Invalid choiceIndex ${choiceIndex} for house ${userId}. Field size: ${game.field.length}. Returning.`));
			this.ai.api('notes/reactions/create', {
				noteId: game.activeReactionNoteId!,
				reaction: 'confused'
			});
			return;
		}

		const chosenAnswer = game.field[choiceIndex];
		// ここで chosenAnswer が undefined の場合、chosenAnswer.playerId でエラーが発生します。
		if (!chosenAnswer) { // 念のため、chosenAnswerがundefinedでないかチェック
			this.log(chalk.red(`[Ohgiri:handleHouseChoice FATAL ERROR] Chosen answer at index ${choiceIndex} is undefined. This should not happen. Returning.`));
			this.ai.api('notes/reactions/create', {
				noteId: game.activeReactionNoteId!,
				reaction: 'confused'
			});
			return;
		}
		this.log(chalk.cyanBright(`[Ohgiri:handleHouseChoice] Chosen answer: ${JSON.stringify(chosenAnswer)}`));

		const winnerPlayer = game.players.find(p => p.id === chosenAnswer.playerId); // ★この行でエラーの可能性
		this.log(chalk.cyanBright(`[Ohgiri:handleHouseChoice] Winner player found: ${winnerPlayer ? JSON.stringify({ id: winnerPlayer.id, username: winnerPlayer.username }) : 'undefined'}`));

		game.history.push({
			turn: game.turn,
			odai: game.currentOdai,
			answers: game.field.map(ans => ({ card: ans.card, player: game.players.find(p => p.id === ans.playerId) || null })),
			chosen: chosenAnswer,
		});

		// 親の選択に「congrats」で反応
		this.ai.api('notes/reactions/create', {
			noteId: game.activeReactionNoteId!,
			reaction: 'congrats'
		});

		if (winnerPlayer) {
			winnerPlayer.points++;
			this.log(chalk.cyanBright(`Winner is ${winnerPlayer.username}. Points: ${winnerPlayer.points}`));
			await this.ai.post({ renoteId: game.postId, text: serifs.ohgiri.playerWin(acct(winnerPlayer), chosenAnswer.card, winnerPlayer.points) });
			game.houseId = winnerPlayer.id; // 次の親は勝者

			if (winnerPlayer.points >= game.winPoints) {
				this.finish(game, winnerPlayer);
				return;
			}
		} else { // ダミーカードが選ばれた場合は親は継続
			const house = game.players.find(p => p.id === game.houseId)!;
			house.points = Math.max(0, house.points - 1);
			this.log(chalk.cyanBright(`Dummy was chosen. House ${house.username} loses a point. Points: ${house.points}`));
			await this.ai.post({ renoteId: game.postId, text: serifs.ohgiri.dummyWin(chosenAnswer.card, acct(house), house.points) });
		}

		game.players.forEach(p => this.drawCards(game, p, 5 - p.hand.length));
		this.ohgiriGames.update(game);
		setTimeout(() => this.startTurn(game), 5000);
	}

	// ゲームを終了し、結果を発表
	@bindThis
	private finish(game: Game, winner: Player | undefined) {
		if (game.isEnded) return;
		this.log(chalk.green.bold('[Ohgiri:finish] Game finished.'));
		game.isEnded = true;

		// 最終的な監視対象投稿のコンテキストを解除
		if (game.activeReactionNoteId) {
			const oldContext = this.ai.db.getCollection('contexts').findOne({ noteId: game.activeReactionNoteId, module: this.name });
			if (oldContext && oldContext.key) {
				this.ai.unsubscribeReply(this, oldContext.key);
				this.log(chalk.green.bold(`[Ohgiri:finish] Unsubscribed final context for noteId: ${game.activeReactionNoteId}, key: ${oldContext.key}`));
			}
		}
		// 念のため、初期の募集投稿のコンテキストも解除
		this.ai.unsubscribeReply(this, 'game-setup');
		this.log(chalk.green.bold(`[Ohgiri:finish] Unsubscribed setup context.`));

		// 終了メッセージを出力し、ゲームを終了
		if (winner === undefined){
			this.log(chalk.green.bold(`[Ohgiri:finish] Game ended with no winner.`));
			this.ai.post({ renoteId: game.postId, text: serifs.ohgiri.noWinner });
		} else {
			this.log(chalk.green.bold(`[Ohgiri:finish] Game ended. Winner: ${winner.username}`));
			const historyText = game.history.map(h => {
				const chosenPlayer = h.answers.find(a => a.card === h.chosen.card)?.player;
				const winnerAcct = chosenPlayer ? acct(chosenPlayer) : 'ダミー';
				const odaiResult = `第${h.turn}問: ${h.odai.replace(/〇〇/g, `$[fg.color=000 ${h.chosen.card}]`)} (回答者: ${winnerAcct})`;
				return odaiResult;
			}).join('\n');

			this.ai.post({ renoteId: game.postId, text: serifs.ohgiri.finish(acct(winner), historyText) });
		}
		this.ohgiriGames.update(game);

		// 古いゲームを記録から削除
		for (const game of this.ohgiriGames.find({ isEnded: true })) {
			this.ohgiriGames.remove(game);
		}
	}

	// 時間切れでゲームを強制終了
	@bindThis
	private crawleGameEnd() {
		const game = this.ohgiriGames.findOne({ isEnded: false });
		if (game && !game.isEnded && Date.now() - game.startedAt > GAME_TIME_LIMIT) {
			this.log(chalk.red.bold('[Ohgiri:crawleGameEnd] Game timed out.'));
			this.ai.post({ renoteId: game.postId, text: serifs.ohgiri.timeout });
			let winner: Player | undefined = game.players.sort((a, b) => b.points - a.points)[0]; // 最高得点者
			// 勝者の点数が0点の場合、勝者なしでゲーム終了
			if (winner.points === 0) {
				winner = undefined;
			}
			this.finish(game, winner);
		}
	}

	// 山札からカードを引くヘルパー関数
	@bindThis
	private drawCards(game: Game, player: Player | null, count: number): string[] {
		const drawnCards: string[] = [];
		for (let i = 0; i < count; i++) {
			if (game.answerDeck.length === 0) {
				game.answerDeck = [...this.ohgiriData.answer].sort(() => Math.random() - 0.5);
			}
			const card = game.answerDeck.pop()!;
			if (player) {
					player.hand.push(card);
			}
			drawnCards.push(card);
		}
		return drawnCards;
	}
}
