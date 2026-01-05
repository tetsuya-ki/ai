# AI Agent Instructions for Misskey AI Bot (藍)

This is a Misskey bot written in TypeScript that responds to mentions, manages interactive games, and integrates with AI services (Gemini, PLaMo).

## Project Overview

**藍** (Ai) is a modular bot system for Misskey social media. Core components:
- **AI Core** ([ai.ts](../src/ai.ts)): Bootstraps the bot, manages modules, handles WebSocket connections to Misskey
- **Module System** ([module.ts](../src/module.ts)): Abstract base class for plugins; each module installs hooks for different interaction types
- **Message Handler** ([message.ts](../src/message.ts)): Wraps Misskey notes with reply/reaction utilities
- **Stream Management** ([stream.ts](../src/stream.ts)): WebSocket listener for mentions, reactions, and timeline events

## Architecture Patterns

### Module Installation & Hooks

Modules (in [src/modules/](../src/modules/)) extend the `Module` base class and implement `install()` returning an `InstallerResult`:

```typescript
// Example: src/modules/ping/index.ts
export default class extends Module {
  public readonly name = 'ping';
  
  @bindThis
  public install() {
    return {
      mentionHook: this.mentionHook,  // Called for @mentions
      contextHook: this.contextHook,  // Called for subscribed context events
      reactionHook: this.reactionHook, // Called for emoji reactions
      timeoutCallback: this.timeout    // Called after delay
    };
  }
  
  private async mentionHook(msg: Message) {
    // Return true if handled, false to allow other modules
  }
}
```

**Hook Types:**
- `mentionHook`: Fires when bot is mentioned; return `true` to prevent fallthrough
- `contextHook`: Fires when reply context created via `subscribeReply()` receives input
- `reactionHook`: Fires on emoji reactions; signature: `(reaction, user, msg) => Promise<void | boolean>`
- `timeoutCallback`: Fires after `setTimeoutWithPersistence()` delay (persists across restarts)

### State Management

- **Per-Module Data**: Use `this.getData()` / `this.setData(data)` (stored in Loki DB)
- **Contexts**: `subscribeReply(key, id, data)` waits for user reply; `unsubscribeReply(key)` cancels
- **Persistent Timers**: `setTimeoutWithPersistence(delay, data)` survives process restarts
- **Friends System**: Friend relationship tracking in DB for bot personality

### Message API

`Message` class provides:
- `msg.text` / `msg.extractedText` (mentions removed)
- `msg.reply(text, options)`: Post reply with optional `{ immediate: true }`
- `msg.react(emoji)`: Add emoji reaction
- `msg.user` / `msg.userId`: Author info
- `msg.visibility`: Note visibility level

## Development Workflow

### Build & Run
```bash
npm install
npm run build           # TypeScript → JavaScript (outputs to built/)
npm start              # Run bot
npm run start-daemon   # Run with auto-reload (nodemon)
npm test               # Jest (if tests exist)
```

### Key Configuration

Create `config.json` from [example.json](../example.json):
- `host`: Misskey instance URL
- `i`: Bot account access token
- `geminiProApiKey` / `pLaMoApiKey`: For aichat module
- `keywordEnabled`: Requires MeCab (Japanese parser)
- `reversiEnabled` / `chartEnabled` / `notingEnabled`: Feature toggles
- `prompt`: Custom prompt for aichat AI responses
- `mecab` / `mecabDic`: MeCab executable paths (Linux: `/usr/local/bin/mecab`)

### Database & Persistence

- **Loki DB**: In-memory database with JSON persistence to `memory.json`
- Collections in AI core: `contexts`, `timers`, `friends`, `moduleData`, `meta`
- Default save location: `.` (repo root) or `data/` (Docker)
- `nodemonConfig.ignore` excludes `memory.json` from restart watching

## Code Patterns & Conventions

1. **Path Aliases**: Use `@/` for src imports (configured in tsconfig.json `paths`)
   ```typescript
   import Message from '@/message.js';
   ```

2. **Decorators**: `@bindThis` preserves method context (required for event listeners)
   ```typescript
   @bindThis
   private async handler() { }
   ```

3. **Serifs**: Localized response text in [serifs.ts](../src/serifs.ts)
   ```typescript
   msg.reply(serifs.dice.done(results));
   ```

4. **Module Names**: Must be unique; used as DB keys (lowercase, hyphen-separated)

5. **Async/Await**: Always handle Misskey API calls with error boundaries

## Important Integration Points

- **Misskey API**: Via `got` HTTP client; endpoints at `config.apiUrl`
- **WebSocket Stream** ([stream.ts](../src/stream.ts)): Listens for mentions, reactions, DMs
- **AI Services**: aichat module calls Gemini/PLaMo APIs with optional Function Calling support
- **External**: Canvas module for image generation; twemoji-parser for emoji handling

## aichat Module: Function Calling

The aichat module supports **Gemini Function Calling** for dynamic data fetching. See [FUNCTION_CALLING.md](../src/modules/aichat/FUNCTION_CALLING.md) for details.

**Key files:**
- [functions.ts](../src/modules/aichat/functions.ts): Function schema definitions (JSON-based, easily extensible)
- [function-executor.ts](../src/modules/aichat/function-executor.ts): Function execution logic
- [index.ts](../src/modules/aichat/index.ts): Integration with Gemini API

**Current functions:**
- `users_notes`: Fetch user posts from Misskey with filters

**To add a function:**
1. Define schema in `functions.ts` with parameters
2. Add execution method in `function-executor.ts`
3. Implement via Misskey API call (e.g., `this.ai.api('users/notes', params)`)
4. Return JSON string of result

Functions enable the AI to answer questions like "What has user X been posting?" by automatically calling the appropriate APIs.

## Adding a New Module

1. Create `src/modules/mymodule/index.ts` extending `Module`
2. Implement `install()` with desired hooks
3. Add import + instantiation in [index.ts](../src/index.ts) module array
4. No registration needed; framework auto-discovers via import

## Testing & Debugging

- Use `this.ai.log(msg)` for console output (prefixed with module name)
- Check `memory.json` for DB state
- WebSocket logs show Misskey API events
- Docker Compose available for isolated testing with MeCab
