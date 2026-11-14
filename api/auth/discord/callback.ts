// GET /api/auth/discord/callback (M5b). A thin shell: Vercel's Node runtime calls the exported
// method handlers with a Web `Request` and sends the returned `Response`. The logic is in
// api/_lib/handlers.ts. Every method is exported so the handler itself answers 405.
// `defaultDeps` accepts the prod target only (A174) and needs AUTH_ORIGIN.
import { defaultDeps, handleCallback } from '../../_lib/handlers.js';
import { DISCORD_ENDPOINTS } from '../../_lib/outbound.js';

const handle = (request: Request): Promise<Response> =>
    handleCallback(request, defaultDeps(process.env, DISCORD_ENDPOINTS));

export {
    handle as DELETE,
    handle as GET,
    handle as HEAD,
    handle as OPTIONS,
    handle as PATCH,
    handle as POST,
    handle as PUT,
};
