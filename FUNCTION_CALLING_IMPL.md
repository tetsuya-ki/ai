# Function Calling Implementation Summary

## What was added

### 1. Function Definitions (`src/modules/aichat/functions.ts`)
- JSON-based schema format for easy extension
- `FunctionSchema` type for type safety
- `AVAILABLE_FUNCTIONS` array containing all callable functions
- `getGeminiFunctionSchema()` helper to export for Gemini API

**Current function:**
```typescript
{
  name: 'users_notes',
  description: 'ユーザーの投稿一覧を取得します',
  parameters: {
    type: 'object',
    properties: {
      userId: { type: 'string', format: 'misskey:id', description: '...' },
      limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
      sinceDate, sinceId, untilDate, untilId, // ... other filters
      withChannelNotes, withFiles, withRenotes, withReplies // ... boolean flags
    },
    required: ['userId']
  }
}
```

### 2. Function Executor (`src/modules/aichat/function-executor.ts`)
- Handles function execution routing
- Maps function names to implementations
- Implements `users_notes` to call Misskey API
- Returns JSON results for Gemini API

```typescript
@bindThis
private async executeUsersNotes(args: Record<string, any>): Promise<string> {
  const params = { userId: args.userId, limit: args.limit ?? 10, ... };
  const result = await this.ai.api('users/notes', params);
  return JSON.stringify(result);
}
```

### 3. Integration in aichat module
- Initializes `FunctionExecutor` in `install()`
- Adds function schemas to Gemini requests (genTextByGemini)
- Detects function calls in Gemini responses (genTextByGeminiCore)
- Executes functions and re-submits results to API
- Supports multi-turn function calling (AI can call functions multiple times)

**Flow in genTextByGeminiCore:**
```
1. Send request to Gemini API with function definitions
2. Check response for functionCall parts
3. If found: execute function, add result to history, re-call API
4. Return final text response
```

## Usage Example

```
User: @藍 what has @john been posting about?

→ Gemini decides to call: users_notes(userId="john_id", limit=5)
→ Misskey API returns: [note1, note2, note3, note4, note5]
→ Gemini sees the results and responds:
  "Based on John's recent posts, he's been discussing..."
```

## Design Philosophy

✅ **JSON-based definitions**: Easy to add new functions without code structure changes
✅ **Pluggable architecture**: New functions require minimal boilerplate
✅ **Type-safe**: TypeScript types for all function schemas
✅ **Error handling**: Graceful fallbacks if functions fail
✅ **Multi-turn capable**: AI can call multiple functions or revisit previous results
✅ **Misskey-focused**: Executor uses existing `this.ai.api()` pattern

## Files Modified

1. `src/modules/aichat/index.ts`
   - Added imports for Function Calling
   - Added `functionExecutor` property
   - Modified type: `GeminiOptions.tools` from `[{}]` to `any[]`
   - Updated `genTextByGemini()` to add function schemas
   - Updated `genTextByGeminiCore()` to detect and execute functions

2. `.github/copilot-instructions.md`
   - Added aichat Function Calling section
   - Reference to `FUNCTION_CALLING.md`

## Testing

Built successfully with `npm run build` - all new TypeScript files compile correctly.

To test:
```bash
npm run build
npm start
# Mention: @藍 what has @someone been posting?
```

Check logs for:
```
Function call detected: users_notes
Function result: [...]
```

## Adding More Functions

1. Add schema to `functions.ts` in `AVAILABLE_FUNCTIONS`
2. Add case in `FunctionExecutor.execute()`
3. Implement private `executeYourFunction()` method
4. Use `this.ai.api()` to call Misskey endpoints
5. Return `JSON.stringify(result)`

That's it! No other changes needed.
