import { handle } from "hono/aws-lambda";
import { bootstrap } from "./bootstrap.js";

/**
 * AWS Lambda entry (API Gateway HTTP API → Lambda, ADR-012). The app is
 * composed from `bootstrap()` which reads env config; in tests the app is
 * built directly with injected fakes (test/app.test.ts).
 */
const app = bootstrap();

export const handler = handle(app);
