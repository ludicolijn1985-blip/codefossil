# API

GET /health

GET /api/repositories
POST /api/repositories
GET /api/repositories/:id
POST /api/repositories/:id/index
GET /api/repositories/:id/status

GET /api/repositories/:id/timeline?path=
GET /api/repositories/:id/files/:fileId
GET /api/repositories/:id/symbols/:symbolId
GET /api/repositories/:id/graph?root=&depth=
GET /api/repositories/:id/impact?target=
GET /api/repositories/:id/hotspots
GET /api/repositories/:id/dead-intent

POST /api/repositories/:id/investigate
POST /api/repositories/:id/providers/github/connect

POST /api/repositories/:id/query

All request bodies and query parameters use Zod schemas.

Investigation response:

```json
{
  "answer": "...",
  "confidence": 0.92,
  "classification": "DERIVED",
  "evidence": [
    {
      "id": "...",
      "type": "commit",
      "locator": "abc123",
      "reason": "Introduced the relevant condition"
    }
  ],
  "related": []
}
```

Never return an unsupported assertion as FACT.
