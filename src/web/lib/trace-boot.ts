/**
 * Starts browser logging. A module of its own so it can be the *first* import of `main.tsx`:
 * imports evaluate in order before any statement runs, so a call written in `main.tsx` itself
 * would only happen after the whole app had already evaluated — and logged — without it.
 */
import { installTraceClient } from "./trace-client";

installTraceClient();
