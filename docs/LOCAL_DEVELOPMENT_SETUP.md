# AI Bookworm - Local Development Setup

## Quick Start

**Access the Running Instance:** http://localhost:3000

## Services Status

| Service | Port | Status | Endpoint |
|---------|------|--------|----------|
| Web App | 3000 | ✅ Running | http://localhost:3000 |
| API | 3001 | ✅ Running | http://localhost:3001 |
| AI Gateway | 8000 | ⏸️ Not started | N/A |

## How to Start Services

```bash
cd C:/Users/Asus/ai-bookworm

# Terminal 1: API Service
npx tsx services/api/src/index.ts
# Health: http://localhost:3001/health

# Terminal 2: Web App
npm run dev -w apps/web
# Access: http://localhost:3000
```

## Environment Setup

The `.env.local` file is pre-configured with Supabase keys for project `cyhqtwndadlyzpeatxws`.

### Missing Keys (Optional - Mock Mode Active)

| Key | Purpose | Mock Fallback |
|-----|---------|---------------|
| OPENAI_API_KEY | AI text generation | N/A |
| ANTHROPIC_API_KEY | AI text generation | MockProvider |
| STRIPE_SECRET_KEY | Billing | In-memory credits |
| STRIPE_WEBHOOK_SECRET | Billing webhooks | Disabled |
| REDIS_URL | Queue/cache | Not required |
| QDRANT_URL | Vector search | Not required |

## Mock Mode Capabilities

- ✅ User signup/signin flow
- ✅ Workspace/book management
- ✅ Document upload (DOCX/EPUB/TXT/PDF)
- ✅ Editor interface
- ✅ AI proofreading (mock responses)
- ✅ Credit ledger (simulated)

## Database Migration Required

Before full production testing, apply migrations:

1. Open: https://supabase.com/dashboard/project/cyhqtwndadlyzpeatxws/editor
2. Paste contents of `docs/apply-migrations.sql`
3. Run the SQL

## Testing the Flow

1. **Access**: Browse to http://localhost:3000
2. **Signup**: Create a new account
3. **Workspace**: Create/join a workspace
4. **Book**: Create a new book
5. **Editor**: Open the book editor
6. **AI Tools**: Use the AI panel (works in mock mode)

## Stopping Services

- API: `Ctrl+C` in terminal running `tsx src/index.ts`
- Web: `Ctrl+C` in terminal running `npm run dev`

## Production Readiness

BMAD Production Audit: **Not Live** - Migrations pending, live keys not configured, Redis/Qdrant not running

See `docs/release-checklist.md` for full production checklists.