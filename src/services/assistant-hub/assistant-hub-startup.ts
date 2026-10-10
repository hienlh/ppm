/**
 * Starts the PPM Assistant's hub: the watches ("tell me when that chat finishes") and, when it is
 * switched on and has a bot, the Telegram bridge. The one startup both the server and the e2e
 * fixtures call, so a test exercises the same wiring the server runs.
 *
 * Order: the watch service first (it settles what a restart left behind; its reports go out on a
 * later tick, by which time the bridge listens); then PPMBot's settings are carried over, once,
 * before the bridge reads them; then the bridge.
 *
 * The Telegram half failing — a bad token, Telegram unreachable — never stops the server or the
 * watches: it is logged, and Settings shows the bridge as not running.
 */
import { assistantWatchService } from "../assistant-watch/assistant-watch.service.ts";
import {
  assistantTelegramBridge, assistantTelegramConfig, type BridgeStartOptions,
} from "../assistant-telegram/assistant-telegram.service.ts";
import { migratePPMBotSettings } from "../assistant-telegram/ppmbot-migration.ts";
import { BOT_TOKEN_RE } from "../telegram/telegram-api-base.ts";
import { getPPMBotBot } from "../telegram-bots.ts";
import { createLogger } from "../logger.ts";

const log = createLogger("assistant-telegram");

export interface AssistantHubOptions {
  /** Passed to the bridge (tests point it at a fake Bot API, shrink waits). */
  bridge?: BridgeStartOptions;
}

/** The options the hub was last started with, reused when Settings restarts the bridge. */
let bridgeOptions: BridgeStartOptions | undefined;

/** Starts whatever is not running yet. Calling it again changes nothing. */
export async function startAssistantHub(opts: AssistantHubOptions = {}): Promise<void> {
  bridgeOptions = opts.bridge;
  try {
    assistantWatchService.start();
  } catch (e) {
    log.error("Assistant watches could not start:", e);
  }
  try {
    migratePPMBotSettings();
  } catch (e) {
    log.warn(`PPMBot's settings could not be carried over: ${(e as Error).message}`);
  }
  await syncAssistantTelegram();
}

/** Stops both halves; safe to call when nothing runs. */
export async function stopAssistantHub(): Promise<void> {
  await assistantTelegramBridge.stop();
  assistantWatchService.stop();
}

/**
 * Brings the bridge in line with Settings: running when switched on and given a bot, stopped
 * otherwise. Errors are logged, not thrown — the caller saved a setting, and that stands.
 */
export async function syncAssistantTelegram(opts: { restart?: boolean } = {}): Promise<void> {
  const wanted = assistantTelegramConfig().enabled && hasBot();
  try {
    if (assistantTelegramBridge.running && (!wanted || opts.restart)) await assistantTelegramBridge.stop();
    if (wanted && !assistantTelegramBridge.running) {
      await assistantTelegramBridge.start(bridgeOptions);
      log.info("Assistant Telegram started");
    }
  } catch (e) {
    log.error(`Assistant Telegram could not ${wanted ? "start" : "stop"}:`, e);
  }
}

function hasBot(): boolean {
  return BOT_TOKEN_RE.test(bridgeOptions?.token ?? getPPMBotBot().bot_token);
}
