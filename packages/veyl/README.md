# Veyl SDK and MCP

Node 22 or later. Obtain a project-scoped token from the hosted workspace's Developer tab. Store it in your application's secret manager or environment, never client-side source or a public repository.

```sh
npm install https://veyl.sh/downloads/veyl-sdk-0.1.0.tgz
```

```js
import { VeylClient, VeylApiError } from '@veyl/sdk';
const veyl = new VeylClient({ token: process.env.VEYL_API_TOKEN });
const { project } = await veyl.project();
const { jobs } = await veyl.jobs();
// Explicitly queues a potentially paid task under existing project limits:
// await veyl.submitJob({ requestKey: crypto.randomUUID(), prompt: 'Summarize the saved project context.' });
```

Methods: `project`, `models`, `jobs`, `job(id)`, `submitJob`, `memory`, `saveMemory`, `drafts`, `prepareDraft`. Responses retain the API's object wrappers. The SDK never retries mutations. On a network timeout or `VeylApiError.uncertain`, inspect jobs/memory/drafts using the same request key before deciding what to do. Server idempotency uses the saved key and exact payload; reusing a key with changed content is rejected.

Scopes are `read`, `jobs`, `memory`, `drafts`. They cannot fund a wallet, trade, change treasury policy, approve or publish a social post. Task submission can spend the project's existing inference allowance if funded and enabled. Draft preparation requires an existing connected account; owner review and separately enabled publishing remain mandatory.

Run the included local stdio MCP adapter with `VEYL_API_TOKEN` supplied through the host's protected environment:

```sh
npx --package https://veyl.sh/downloads/veyl-sdk-0.1.0.tgz veyl-mcp
```

This is a local stdio adapter with bearer-token authorization, not a hosted OAuth MCP endpoint. See https://veyl.sh/developers for the API, token setup and supported tools. Live paid/provider acceptance was deliberately not performed.
