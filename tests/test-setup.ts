import { setDb, openTestDb } from "../src/services/db.service.ts";
import { configService } from "../src/services/config.service.ts";

// Use in-memory DB for all tests (prevents polluting real DB)
setDb(openTestDb());

// Disable auth for all tests
const config = (configService as any).config;
config.auth.enabled = false;
