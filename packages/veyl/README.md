# Veyl SDK and MCP

Node 22 or later. Obtain a project-scoped token from the hosted workspace's Developer tab. Store it in your application's secret manager or environment, never client-side source or a public repository.

```sh
npm install https://veyl.sh/downloads/veyl-sdk-0.2.0.tgz
```

```js
import { VeylClient, VeylApiError } from '@veyl/sdk';
const veyl = new VeylClient({ token: process.env.VEYL_API_TOKEN });
const { project } = await veyl.project();
const { jobs } = await veyl.jobs();
// Explicitly queues a potentially paid task under existing project limits:
// await veyl.submitJob({ requestKey: crypto.randomUUID(), prompt: 'Summarize the saved project context.' });
```

Methods: `project`, `models`, `jobs`, `job(id)`, `submitJob`, `memory`, `saveMemory`, `drafts`, `prepareDraft`, `research`, `createWatchlist`, `updateWatchlist`, `checkWatchlist`. Responses retain the API's object wrappers. The SDK never retries mutations. On a network timeout or `VeylApiError.uncertain`, inspect the saved records using the original key before deciding what to do. Watchlist updates set fields without a key; read back their current values after an uncertain response.

Scopes are `read`, `jobs`, `memory`, `drafts`. They cannot fund a wallet, trade, change treasury policy, approve or publish a social post. Task submission can spend the project's existing inference allowance if funded and enabled. Research creation, updates and manual checks require `jobs`; `read` allows research history. An enabled watchlist authorizes recurring checks and potentially paid reports under existing project limits. Draft preparation requires an existing connected account; owner review and separately enabled publishing remain mandatory.

```js
const { sourceHosts } = await veyl.research();
// Persist this creation key before sending. The example schedule is disabled.
const { watchlist } = await veyl.createWatchlist({
  requestKey: crypto.randomUUID(), name: 'Protocol updates',
  brief: 'Explain material changes and cite the captured sources.',
  sources: ['https://ethereum.org/en/'], enabled: false,
  cadenceMinutes: 360, reviewerModel: null
});
// Explicit check: changed content can queue a paid report.
const { check } = await veyl.checkWatchlist(watchlist.id, { requestKey: crypto.randomUUID() });
```

The first successful check records a baseline; unchanged checks use no inference. Changes queue a report through the ordinary project budget and zkAPI accounting. Optional `reviewerModel` must differ from the project model and adds a separate budgeted job after the report completes. Each project keeps ten watches, three approved HTTPS sources per watch and fifty recent checks. Cadence is 60, 360 or 1440 minutes; creation requires explicit `enabled`. Source URLs are capped at 1,024 characters and only the first 20,000 readable characters are compared. This reader does not run page JavaScript or a browser. Changing sources resets the baseline. Read `research()` for allowed hosts, actual fetch evidence and linked job IDs; full job results remain available with `job(id)`.

Creation and check keys use the ordinary 16 to 80 character request-key format; UUIDs are recommended. Repeated creation with different original settings is rejected. A repeated retained check key returns its original record without another fetch or report; an expired check key is rejected rather than dispatched again. After uncertain outcomes, inspect the history rather than creating a new key. History is bounded, so archive records you need before older completed checks are removed. Snapshots include short result previews and are capped at 750 KB; `historyOmitted` counts older checks omitted from that response. Full report artifacts remain available through their linked job IDs.

Drafts accept up to 4,096 raw characters. The server uses X's official parser for its 280 weighted-character limit, including URL shortening, combined emoji and Unicode normalization. `madeWithAi` records AI assistance in Veyl's review; it does not request an X media label for a text-only post.

Run the included local stdio MCP adapter with `VEYL_API_TOKEN` supplied through the host's protected environment:

```sh
npx --package https://veyl.sh/downloads/veyl-sdk-0.2.0.tgz veyl-mcp
```

This is a local stdio adapter with bearer-token authorization, not a hosted OAuth MCP endpoint. See https://veyl.sh/developers for the API, token setup and supported tools. Live paid/provider acceptance was deliberately not performed.
