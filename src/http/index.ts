/**
 * Rowst HTTP-to-WebSocket Router Module
 *
 * Provides Express-style routing for bridging HTTP REST APIs to WebSocket backends.
 *
 * Example:
 *   import { AsyncResolver, WebSocketTransport } from 'rowst'
 *   import { RowstRouter, HonoAdapter } from 'rowst/http'
 *
 *   const ws = new WebSocket('ws://backend.example.com')
 *   const resolver = new AsyncResolver(new WebSocketTransport(ws))
 *   const router = new RowstRouter(resolver)
 *
 *   router.get('/users/:id', 'fetchUser')
 *   router.post('/posts', 'createPost')
 *
 *   const adapter = new HonoAdapter(router)
 *   adapter.register(app)
 */

export { ExpressAdapter } from "./adapters/ExpressAdapter.js";
export { FastifyAdapter } from "./adapters/FastifyAdapter.js";
// Framework adapters
export { HonoAdapter } from "./adapters/HonoAdapter.js";
export { ResponseParser } from "./ResponseParser.js";
export { RouteCompiler } from "./RouteCompiler.js";
// Core
export { RowstRouter } from "./RowstRouter.js";

// Types
export type {
	CompiledRoute,
	HttpMethod,
	HttpRequest,
	HttpResponse,
	RouteConfig,
	RouteMatch,
	RowstRouterOptions,
	UpstreamRequestPayload,
	UpstreamResponse,
} from "./types.js";
