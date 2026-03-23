declare module "qrcode-terminal" {
  export function generate(text: string, opts?: { small?: boolean }, cb?: (qrcode: string) => void): void;
}
