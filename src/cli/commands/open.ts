import { configService } from "../../services/config.service.ts";

export async function openBrowser() {
  configService.load();
  const port = configService.get("port");
  const url = `http://localhost:${port}`;

  console.log(`Opening ${url} ...`);

  const platform = process.platform;
  const cmd =
    platform === "darwin"
      ? ["open", url]
      : platform === "win32"
        ? ["cmd", "/c", "start", url]
        : ["xdg-open", url];

  Bun.spawn({ cmd, stdio: ["ignore", "ignore", "ignore"] });
}
