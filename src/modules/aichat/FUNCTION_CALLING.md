# Function Calling Feature for aichat Module

## Overview

The aichat module now supports **Function Calling** with Gemini API, allowing the AI to call predefined functions to fetch real-world data and make informed decisions based on the results.

## Architecture

### Components

1. **`functions.ts`** - Function definitions in JSON format
   - `FunctionSchema`: Type definition for function metadata
   - `AVAILABLE_FUNCTIONS`: Array of callable functions
   - `getGeminiFunctionSchema()`: Exports schemas for Gemini API

2. **`function-executor.ts`** - Function execution handler
   - `FunctionExecutor`: Class that handles function execution
   - Maps function names to actual implementations
   - Returns JSON results to Gemini API

3. **`index.ts` (aichat module)** - Integration point
   - Passes function schemas to Gemini API
   - Detects function calls in API responses
   - Executes functions and feeds results back to API

## Current Implementation

### Available Functions

#### `users_notes`
Retrieves a user's posts from Misskey instance.

**Parameters:**
- `userId` (required, string): The user's ID in Misskey format
- `limit` (integer, 1-100): Number of posts to retrieve (default: 10)
- `sinceDate` (integer): Fetch posts after this timestamp
- `sinceId` (string): Fetch posts after this note ID
- `untilDate` (integer): Fetch posts before this timestamp
- `untilId` (string): Fetch posts before this note ID
- `withChannelNotes` (boolean): Include channel notes (default: false)
- `withFiles` (boolean): Only posts with files (default: false)
- `withRenotes` (boolean): Include renotes (default: true)
- `withReplies` (boolean): Include replies (default: false)

**Example:**
```
AI question: "What has @user recently posted?"
→ AI calls: users_notes(userId="abc123", limit=5)
→ Result: Array of recent notes
→ AI: "Based on their recent posts..."
```

## Adding New Functions

### Step 1: Define Function Schema

Edit `src/modules/aichat/functions.ts`:

```typescript
export const AVAILABLE_FUNCTIONS: FunctionSchema[] = [
	// ... existing functions
	{
		name: 'your_function_name',
		description: 'What this function does',
		parameters: {
			type: 'object',
			properties: {
				param1: {
					type: 'string',
					description: 'Description of param1'
				},
				param2: {
					type: 'integer',
					minimum: 1,
					maximum: 100,
					default: 10,
					description: 'Description of param2'
				}
			},
			required: ['param1']
		}
	}
];
```

### Step 2: Implement Function Execution

Edit `src/modules/aichat/function-executor.ts`:

```typescript
@bindThis
public async execute(functionCall: FunctionCall): Promise<string> {
	switch (functionCall.name) {
		case 'your_function_name':
			return await this.executeYourFunction(functionCall.arguments);
		// ... other cases
	}
}

@bindThis
private async executeYourFunction(args: Record<string, any>): Promise<string> {
	// Extract arguments with defaults
	const param1 = args.param1;
	const param2 = args.param2 ?? 10;
	
	try {
		// Implement your logic
		const result = await this.ai.api('your/endpoint', {
			param1,
			param2
		});
		return JSON.stringify(result);
	} catch (err: unknown) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to execute: ${errorMsg}`);
	}
}
```

## Data Flow

```
User mention
    ↓
Message received by mentionHook
    ↓
Add function schemas to Gemini request
    ↓
Gemini API responds with:
    ├─ Text content
    └─ Function call (name + arguments)
    ↓
Check for function calls in response
    ↓
If function call detected:
    ├─ Execute function via FunctionExecutor
    ├─ Get result (JSON)
    ├─ Add function result to message history
    └─ Re-call Gemini API with result
    ↓
Generate final response
    ↓
Post reply to user
```

## Important Notes

- Functions are only enabled for normal conversation (not memory generation or sensitivity checks)
- Function results are added to the conversation context for the AI to understand and respond
- All function results must be returned as JSON strings
- Function calls can be chained - the AI may call multiple functions or call functions again based on previous results
- Error handling is built-in: exceptions are caught and returned as error objects to the AI

## Testing

To test function calling:

1. Mention the bot and ask it to retrieve user information:
   ```
   @藍 what has @someuser been posting lately?
   ```

2. The bot should:
   - Recognize the need for function calling
   - Call `users_notes` with appropriate parameters
   - Use the results to generate a relevant response

3. Check logs for:
   ```
   Function call detected: users_notes
   Function result: [...]
   ```

## Future Enhancements

Potential functions to add:
- `notes/show` - Get detailed information about a specific note
- `users/show` - Get user profile information
- `timeline` - Get instance or user timeline
- `search/notes` - Search for notes by content
- Custom business logic functions specific to your use case
