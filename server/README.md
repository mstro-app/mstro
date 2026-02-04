# Mstro v2 Server - Modern Hono Implementation

## Overview

This is a modernized server implementation for Mstro v2, built with **Hono** - a lightweight, fast, and type-safe web framework.

### Why Hono?

Migrating from Express (mstro-v1) to Hono provides:

- **Modern & Fast**: Built for edge computing with minimal overhead (~12KB vs Express's much larger footprint)
- **TypeScript-first**: Excellent type inference for routes and context
- **Web Standards**: Built on Web APIs (Request/Response objects)
- **Cleaner Code**: Less boilerplate, more declarative than Express
- **Future-proof**: Works with Node.js, Bun, Deno, and Cloudflare Workers
- **Better Performance**: Significantly faster routing and middleware execution

## Architecture

```
server/
├── index.ts              # Main server entry point
├── types.ts              # TypeScript type definitions
├── services/
│   └── scores.ts         # Score management service
└── tsconfig.json         # TypeScript configuration
```

## Running the Server

### Development Mode
```bash
npm run dev:server
```

The server will start on port `3001` by default. You can change this by setting the `PORT` environment variable:

```bash
PORT=8080 npm run dev:server
```

## API Endpoints

### Health & Configuration

- **GET** `/health` - Health check endpoint
  ```json
  {
    "status": "ok",
    "timestamp": "2025-11-14T14:45:42.425Z",
    "version": "2.0.0",
    "framework": "Hono"
  }
  ```

- **GET** `/api/config` - Server configuration
  ```json
  {
    "lockWithPin": false,
    "version": "2.0.0",
    "framework": "Hono"
  }
  ```

### Scores Management

- **GET** `/api/scores` - List all scores (local, global, examples)
  ```json
  {
    "scores": {
      "localScores": [...],
      "globalScores": [...],
      "exampleScores": [...]
    }
  }
  ```

- **GET** `/api/scores/:filename` - Get a specific local score
- **GET** `/api/scores/examples/:filename` - Get a specific example score
- **GET** `/api/scores/global/:filename` - Get a specific global score

- **POST** `/api/scores` - Save a new score
  ```json
  {
    "metadata": {
      "name": "My Score",
      "version": "1.0.0",
      "description": "Score description"
    },
    "config": {
      "defaultModel": "sonnet"
    },
    "movements": [...],
    "entryPoint": "step1"
  }
  ```

## Middleware Stack

1. **CORS** - Cross-origin resource sharing enabled for all routes
2. **Logger** - HTTP request logging for debugging
3. **Error Handling** - Centralized error handling with proper status codes

## Testing

### Manual Testing

```bash
# Health check
curl http://localhost:3001/health

# List scores
curl http://localhost:3001/api/scores

# Get specific score
curl http://localhost:3001/api/scores/my-score.json

# Save a score
curl -X POST http://localhost:3001/api/scores \
  -H "Content-Type: application/json" \
  -d @score.json
```

## Migration Status

### ✅ Completed
- [x] Health check endpoint
- [x] Configuration endpoint
- [x] List all scores (local, global, examples)
- [x] Get specific score by filename and type
- [x] Save new scores

### 🔄 To Be Migrated
- [ ] Execute score endpoints
- [ ] WebSocket for improvise sessions
- [ ] Instances management
- [ ] Git integration endpoints
- [ ] Authentication/PIN management
- [ ] File autocomplete endpoint
- [ ] Score generation with AI (streaming)

## Type Safety

All routes are fully typed using TypeScript. The `OrchestraScore` type ensures consistency across the entire application:

```typescript
interface OrchestraScore {
  metadata: {
    name: string
    version: string
    description?: string
    // ...
  }
  movements: Movement[]
  entryPoint: string
}
```

## Performance Comparison

Hono vs Express benchmarks (approximate):

- **Routing**: ~3-4x faster
- **JSON parsing**: ~2x faster
- **Memory footprint**: ~60% smaller
- **Bundle size**: ~95% smaller

## Next Steps

1. **Add WebSocket support** for real-time improvise sessions
2. **Implement streaming endpoints** for score generation
3. **Add authentication middleware** for PIN-based security
4. **Set up rate limiting** for production use
5. **Consider Bun runtime** for even better performance

## Compatibility

- Node.js 18+ (ESM modules)
- TypeScript 5.9+
- Compatible with the existing mstro-v1 client (same API surface)

## MCP Server

The MCP bouncer server is now integrated into mstro-v2 at `server/mcp/`. Start it with:
```bash
npm run dev:mcp
# or
bun run server/mcp/server.ts
```

The server provides security analysis for Claude Code tool use via the Model Context Protocol.
