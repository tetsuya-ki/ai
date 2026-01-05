# Function Calling Quick Start Guide

## Overview

Function Calling allows the aichat module to dynamically fetch real-time data from the Misskey instance and use it to provide informed responses.

## Currently Available Functions

### `users_notes` - Get user's posts

**What it does:** Retrieves recent posts from a specific user

**Common scenarios:**
- "What has @username been posting about?"
- "Show me @username's recent activity"
- "What notes did @username post today?"

**Parameters:**
| Parameter | Type | Required | Default | Notes |
|-----------|------|----------|---------|-------|
| userId | string | ✓ | - | User ID in Misskey format |
| limit | integer | | 10 | How many posts (1-100) |
| withFiles | boolean | | false | Only posts with attachments |
| withRenotes | boolean | | true | Include reposted notes |
| withReplies | boolean | | false | Include reply notes |
| withChannelNotes | boolean | | false | Include channel notes |
| sinceId | string | | - | Posts after specific note ID |
| untilId | string | | - | Posts before specific note ID |
| sinceDate | integer | | - | Posts after timestamp |
| untilDate | integer | | - | Posts before timestamp |

## How It Works

```
1. User mentions the bot
2. AI recognizes it needs data (e.g., "user's posts")
3. AI calls users_notes with appropriate parameters
4. Function fetches from Misskey API
5. Results are returned to AI
6. AI generates response based on actual data
7. Bot replies with informed answer
```

## Adding a New Function

### Example: Add `users/show` (Get user profile)

**Step 1:** Add to `src/modules/aichat/functions.ts`

```typescript
export const AVAILABLE_FUNCTIONS: FunctionSchema[] = [
	// ... existing functions
	{
		name: 'users_show',
		description: 'ユーザーのプロフィール情報を取得します',
		parameters: {
			type: 'object',
			properties: {
				userId: {
					type: 'string',
					format: 'misskey:id',
					description: 'ユーザーID'
				}
			},
			required: ['userId']
		}
	}
];
```

**Step 2:** Add to `src/modules/aichat/function-executor.ts`

```typescript
@bindThis
public async execute(functionCall: FunctionCall): Promise<string> {
	switch (functionCall.name) {
		case 'users_notes':
			return await this.executeUsersNotes(functionCall.arguments);
		case 'users_show':  // ← Add this
			return await this.executeUsersShow(functionCall.arguments);
		default:
			return JSON.stringify({ error: `Unknown function: ${functionCall.name}` });
	}
}

@bindThis
private async executeUsersShow(args: Record<string, any>): Promise<string> {
	this.log(`Fetching user info for userId: ${args.userId}`);
	try {
		const result = await this.ai.api('users/show', {
			userId: args.userId
		});
		return JSON.stringify(result);
	} catch (err: unknown) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		this.log(`API error: ${errorMsg}`);
		throw new Error(`Failed to fetch user info: ${errorMsg}`);
	}
}
```

**Step 3:** Build and test

```bash
npm run build
npm start
# Test: @藍 tell me about @someuser
```

## Best Practices

✅ **Do:**
- Use meaningful parameter names that reflect Misskey API
- Include default values for optional parameters
- Add clear descriptions for each parameter
- Handle errors gracefully with try/catch
- Return JSON strings (not objects)
- Use existing `this.ai.api()` calls

❌ **Don't:**
- Create functions that return huge amounts of data (limits apply)
- Duplicate Misskey API structure - it's already well-designed
- Forget error handling
- Return non-JSON data
- Create functions for simple static data

## Debugging

Check the bot logs for:

```
[aichat]: Function call detected: users_notes
[FunctionExecutor]: Fetching notes for userId: abc123
[FunctionExecutor]: Function result: [...]
```

If function isn't being called:
- Check if it's defined in `functions.ts`
- Verify schema is valid JSON
- Make sure parameters have correct types
- Check that the Gemini model can access the function (it's passed in options)

## Limitations

- Functions only work with Gemini API (not PLaMo)
- Function results are limited in size to prevent token overflow
- The AI must decide when to call a function (can't force it)
- Each function call adds latency to the response

## More Examples

### Example 1: Check if user is active

```
Query: "Is @user currently active?"
→ users_notes(userId=..., limit=1)
→ AI checks recent post timestamp
→ Response: "Yes, they posted 2 hours ago"
```

### Example 2: Filter specific content

```
Query: "Show me @user's recent image posts"
→ users_notes(userId=..., limit=10, withFiles=true)
→ AI filters for image-only notes
→ Response: Shows recent images with descriptions
```

### Example 3: Timeline analysis

```
Query: "What's @user been talking about this week?"
→ users_notes(userId=..., limit=20, sinceDate=<7daysago>)
→ AI summarizes common themes
→ Response: Topic summary with examples
```
