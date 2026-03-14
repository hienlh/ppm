import { configService } from "../../src/services/config.service.ts";

// Disable auth for all chat tests
const config = (configService as any).config;
config.auth.enabled = false;
